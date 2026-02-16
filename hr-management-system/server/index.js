import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import multer from 'multer';
import https from 'https';
import OSS from 'ali-oss';
import COS from 'cos-nodejs-sdk-v5';
import { Pool } from 'pg';
import { Readable } from 'stream';

const PORT = Number(process.env.PORT || 3000);
const HOST = String(process.env.HOST || '0.0.0.0');
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const STARTED_AT = new Date().toISOString();

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const OSS_REGION = process.env.OSS_REGION;
const OSS_BUCKET = process.env.OSS_BUCKET;
const OSS_ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID;
const OSS_ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET;
const OSS_PUBLIC_BASE_URL = process.env.OSS_PUBLIC_BASE_URL;
const OSS_TIMEOUT_MS = Number(process.env.OSS_TIMEOUT_MS || 600000);
const OSS_PART_SIZE_MB = Number(process.env.OSS_PART_SIZE_MB || 10);
const OSS_PARALLEL = Number(process.env.OSS_PARALLEL || 3);
const OSS_RETRY_COUNT = Number(process.env.OSS_RETRY_COUNT || 6);

const COS_SECRET_ID = process.env.COS_SECRET_ID;
const COS_SECRET_KEY = process.env.COS_SECRET_KEY;
const COS_BUCKET = process.env.COS_BUCKET;
const COS_REGION = process.env.COS_REGION;
const COS_PUBLIC_BASE_URL = process.env.COS_PUBLIC_BASE_URL;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, 'uploads');
function ensureUploadsDir() {
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
  } catch (e) {
    console.error('[ensureUploadsDir] mkdirSync failed:', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
  try {
    fs.accessSync(uploadsDir, fs.constants.R_OK | fs.constants.W_OK);
    return { ok: true };
  } catch (e) {
    console.error('[ensureUploadsDir] accessSync failed:', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}
try {
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.accessSync(uploadsDir, fs.constants.R_OK | fs.constants.W_OK);
  console.log('[uploads] Uploads dir ready:', uploadsDir);
} catch (e) {
  console.error('[uploads] Cannot ensure uploads dir writable:', e?.message || e);
  try { fs.chmodSync(uploadsDir, 0o755); } catch (e2) {
    console.error('[uploads] chmod fallback also failed:', e2?.message || e2);
  }
}

app.get('/api/approvals', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });

  const view = String(req.query?.view || 'assigned').trim();
  const status = String(req.query?.status || '').trim();
  const type = normalizeApprovalType(req.query?.type || '') || '';
  const storeQ = String(req.query?.store || '').trim();
  const limit = Math.min(200, Math.max(1, Number(req.query?.limit || 100)));

  const allowedViews = ['assigned', 'created', 'all'];
  if (!allowedViews.includes(view)) return res.status(400).json({ error: 'invalid_view' });

  if (view === 'all') {
    const canSeeAll = (role === 'admin' || role === 'hq_manager' || role === 'cashier');
    const hrManagerRewardAll = (role === 'hr_manager' && type === 'reward_punishment');
    const storeManagerPaymentAll = (role === 'store_manager' && type === 'payment');
    if (!(canSeeAll || hrManagerRewardAll || storeManagerPaymentAll)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  const clauses = [];
  const params = [];
  if (view === 'assigned') {
    params.push(username);
    clauses.push(`(lower(current_assignee_username) = lower($${params.length}) OR (status = 'pending' AND EXISTS (SELECT 1 FROM jsonb_array_elements(chain) elem WHERE lower(elem->>'assignee') = lower($${params.length}) AND elem->>'status' = 'pending')))`);
  } else if (view === 'created') {
    params.push(username);
    clauses.push(`lower(applicant_username) = lower($${params.length})`);
  }

  if (type) {
    params.push(type);
    clauses.push(`type = $${params.length}`);
  }

  {
    let store = storeQ;
    try {
      if (role === 'store_manager' && type === 'payment') {
        const state0 = (await getSharedState()) || {};
        store = pickMyStoreFromState(state0, username) || storeQ;
      }
    } catch (e) {}

    // For store_manager viewing all payments, enforce store filter to their own store
    if (role === 'store_manager' && type === 'payment' && view === 'all') {
      if (store) {
        params.push(store);
        clauses.push(`payload->>'store' = $${params.length}`);
      }
    } else if (storeQ) {
      params.push(storeQ);
      clauses.push(`payload->>'store' = $${params.length}`);
    }
  }
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  params.push(limit);

  const where = clauses.length ? ('where ' + clauses.join(' and ')) : '';

  try {
    const r = await pool.query(
      `select id, type, status, applicant_username, current_assignee_username, chain, payload, effective_date, executed_at, created_at, updated_at
       from approval_requests
       ${where}
       order by created_at desc
       limit $${params.length}`,
      params
    );
    return res.json({ items: r.rows || [] });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/points/records', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!(role === 'admin' || role === 'hr_manager' || role === 'store_manager')) return res.status(403).json({ error: 'forbidden' });

  const store = String(req.query?.store || '').trim();
  const name = String(req.query?.name || '').trim().toLowerCase();
  const start = safeDateOnly(req.query?.start);
  const end = safeDateOnly(req.query?.end);

  try {
    const state0 = (await getSharedState()) || {};
    const myStore = role === 'store_manager' ? String(pickMyStoreFromState(state0, username) || '').trim() : '';
    const effectiveStore = role === 'store_manager' ? myStore : store;
    let list = Array.isArray(state0.pointRecords) ? state0.pointRecords.slice() : [];
    if (effectiveStore) list = list.filter(x => String(x?.store || '').trim() === effectiveStore);
    if (name) {
      list = list.filter(x => {
        const n = String(x?.name || '').trim().toLowerCase();
        const u = String(x?.username || '').trim().toLowerCase();
        return n.includes(name) || u.includes(name);
      });
    }
    if (start) list = list.filter(x => String(x?.approvedAt || x?.createdAt || '').slice(0, 10) >= start);
    if (end) list = list.filter(x => String(x?.approvedAt || x?.createdAt || '').slice(0, 10) <= end);

    list.sort((a, b) => String(b?.approvedAt || b?.createdAt || '').localeCompare(String(a?.approvedAt || a?.createdAt || '')));
    return res.json({ items: list, total: list.length });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/payments/budget-summary', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });

  const store = String(req.query?.store || '').trim();
  const month = safeMonthOnly(req.query?.month);
  const category = String(req.query?.category || '').trim();
  const excludeId = safeUuid(req.query?.excludeId);

  if (!store || !month || !category) {
    return res.status(400).json({ error: 'missing_params', message: 'store/month/category required' });
  }

  try {
    const state0 = (await getSharedState()) || {};
    const budgets = Array.isArray(state0.paymentBudgets) ? state0.paymentBudgets : [];
    const key = `${store}__${month}__${category}`.toLowerCase();
    const budgetRow = budgets.find(b => {
      const s = String(b?.store || '').trim();
      const m = String(b?.month || '').trim();
      const c = String(b?.category || '').trim();
      if (!s || !m || !c) return false;
      return `${s}__${m}__${c}`.toLowerCase() === key;
    }) || null;

    const budgetAmount = safeNumber(budgetRow?.amount);

    // Find all secondary categories under this primary category
    const ps = state0.paymentSettings || {};
    const secondaryCats = Array.isArray(ps.secondaryCategories) ? ps.secondaryCategories : [];
    const matchingSecondary = secondaryCats
      .filter(s => String(s?.primary || '').trim().toLowerCase() === category.toLowerCase())
      .map(s => String(s?.name || '').trim())
      .filter(Boolean);
    // Include the primary category itself and all its secondary categories for matching
    const allCats = [category, ...matchingSecondary];
    const uniqueCats = [...new Set(allCats.map(c => c.toLowerCase()))];

    // Build parameterized query for category IN list
    const params = [store, month];
    let excludeClause = '';
    if (excludeId) {
      params.push(excludeId);
      excludeClause = ` and id <> $${params.length}`;
    }
    const catPlaceholders = uniqueCats.map((_, i) => `$${params.length + i + 1}`).join(',');
    params.push(...uniqueCats);

    const r = await pool.query(
      `select status, coalesce(sum(nullif(payload->>'amount','')::numeric), 0)::float as amt
       from approval_requests
       where type = 'payment'
         and status in ('pending','approved','paid')
         and (payload->>'store') = $1
         and lower(payload->>'category') in (${catPlaceholders})
         and substring(payload->>'date', 1, 7) = $2
         ${excludeClause}
       group by status`,
      params
    );

    let usedPending = 0;
    let usedApproved = 0;
    let usedPaid = 0;
    for (const row of (r.rows || [])) {
      const st = String(row?.status || '').trim();
      const amt = safeNumber(row?.amt) || 0;
      if (st === 'pending') usedPending = amt;
      else if (st === 'approved') usedApproved = amt;
      else if (st === 'paid') usedPaid = amt;
    }
    const usedTotal = (usedPending || 0) + (usedApproved || 0) + (usedPaid || 0);
    const remaining = budgetAmount == null ? null : (budgetAmount - usedTotal);

    return res.json({
      store,
      month,
      category,
      budget: budgetAmount == null ? null : budgetAmount,
      usedPending,
      usedApproved,
      usedPaid,
      usedTotal,
      remaining
    });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/approvals', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  const type = normalizeApprovalType(req.body?.type);
  const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!type) return res.status(400).json({ error: 'invalid_type' });

  try {
    if (type === 'onboarding') {
      const empUser = String((payload?.employee?.username) || '').trim().toLowerCase();
      if (empUser) {
        const existing = await pool.query(
          `select id from approval_requests where type = 'onboarding' and status = 'pending' and lower(payload->'employee'->>'username') = $1 limit 1`,
          [empUser]
        );
        if ((existing.rows || []).length) {
          return res.status(409).json({ error: 'duplicate_pending', id: existing.rows[0].id });
        }
      }
    } else if (type !== 'payment') {
      const existing = await pool.query(
        'select id from approval_requests where lower(applicant_username) = lower($1) and type = $2 and status = $3 limit 1',
        [username, type, 'pending']
      );
      if ((existing.rows || []).length) {
        return res.status(409).json({ error: 'duplicate_pending', id: existing.rows[0].id });
      }
    }

    const state = (await getSharedState()) || {};
    const applicant = stateFindUserRecord(state, username) || {};
    const applicantManager = String(applicant?.managerUsername || '').trim();
    const adminUsername = await pickAdminUsername(state);
    const hqManagerUsername = await pickHqManagerUsername(state);
    const cashierUsername = await pickCashierUsername(state);
    const hrManagerUsername = await pickHrManagerUsername(state);

    let assignees = [];

    // validations (independent of configured flow)
    if (type === 'onboarding') {
      if (role !== 'store_manager') {
        return res.status(403).json({ error: 'forbidden' });
      }
      if (!applicantManager) {
        return res.status(400).json({ error: 'missing_manager' });
      }
      const emp = payload?.employee && typeof payload.employee === 'object' ? payload.employee : {};
      const newUsername = String(emp?.username || '').trim();
      if (!newUsername) return res.status(400).json({ error: 'missing_employee_username' });
      const joinDate = safeDateOnly(emp?.joinDate || emp?.hireDate || emp?.startDate || emp?.entryDate || emp?.onboardDate || emp?.joiningDate);
      if (!joinDate) return res.status(400).json({ error: 'missing_join_date' });
      payload.employee = { ...emp, joinDate };
      const exists = stateFindUserRecord(state, newUsername);
      if (exists) return res.status(400).json({ error: 'employee_username_exists' });
    } else if (type === 'offboarding') {
      if (!applicantManager) {
        return res.status(400).json({ error: 'missing_manager' });
      }
    } else if (type === 'leave') {
      if (!applicantManager) {
        return res.status(400).json({ error: 'missing_manager' });
      }
      const startDate = safeDateOnly(payload?.startDate || payload?.fromDate || payload?.beginDate);
      const endDate = safeDateOnly(payload?.endDate || payload?.toDate || payload?.finishDate);
      if (!startDate || !endDate) {
        return res.status(400).json({ error: 'missing_leave_date' });
      }
    } else {
      if (type === 'payment') {
        if (!(role === 'admin' || role === 'hq_manager' || role === 'hr_manager' || role === 'store_manager')) {
          return res.status(403).json({ error: 'forbidden' });
        }

        const store = String(payload?.store || '').trim();
        const date = safeDateOnly(payload?.date || payload?.applyDate || payload?.requestDate);
        const amount = safeNumber(payload?.amount);
        const category = String(payload?.category || payload?.project || '').trim();
        if (!store) return res.status(400).json({ error: 'missing_store' });
        if (!date) return res.status(400).json({ error: 'missing_date' });
        if (amount == null || amount <= 0) return res.status(400).json({ error: 'missing_amount' });
        if (!category) return res.status(400).json({ error: 'missing_category' });
      } else if (type === 'reward_punishment') {
        if (!(role === 'admin' || role === 'hq_manager' || role === 'hr_manager' || role === 'store_manager')) {
          return res.status(403).json({ error: 'forbidden' });
        }
        const targetUsername = String(payload?.targetUsername || payload?.employeeUsername || '').trim();
        const reason = String(payload?.reason || '').trim();
        const result = String(payload?.result || '').trim();
        const amount = safeNumber(payload?.amount);
        if (!targetUsername) return res.status(400).json({ error: 'missing_target' });
        if (!reason) return res.status(400).json({ error: 'missing_reason' });
        if (!result) return res.status(400).json({ error: 'missing_result' });
        if (amount == null || amount <= 0) return res.status(400).json({ error: 'missing_amount' });
      } else if (type === 'points') {
        if (!(role === 'store_employee' || role === 'employee')) {
          return res.status(403).json({ error: 'forbidden' });
        }
        if (!applicantManager) {
          return res.status(400).json({ error: 'missing_manager' });
        }
        const applicantStore = String(applicant?.store || '').trim();
        if (!applicantStore) return res.status(400).json({ error: 'missing_store' });
        const ruleId = String(payload?.ruleId || '').trim();
        const reason = String(payload?.reason || '').trim();
        if (!ruleId) return res.status(400).json({ error: 'missing_rule' });
        if (!reason) return res.status(400).json({ error: 'missing_reason' });
        const rules = Array.isArray(state?.pointRules) ? state.pointRules : [];
        const rule = rules.find(r => String(r?.id || '').trim() === ruleId);
        if (!rule) return res.status(400).json({ error: 'invalid_rule' });
        if (rule?.enabled === false) return res.status(400).json({ error: 'rule_disabled' });
        const ruleStore = String(rule?.store || '').trim();
        if (ruleStore && ruleStore !== applicantStore) return res.status(400).json({ error: 'rule_store_mismatch' });
        const rulePoints = safeNumber(rule?.points);
        if (rulePoints == null || rulePoints <= 0) return res.status(400).json({ error: 'invalid_rule_points' });
        payload.store = applicantStore;
        payload.itemName = String(rule?.itemName || payload?.itemName || '').trim() || '积分事项';
        payload.points = rulePoints;
        payload.ruleId = ruleId;
        payload.evidenceUrls = Array.isArray(payload?.evidenceUrls) ? payload.evidenceUrls.map(x => String(x || '').trim()).filter(Boolean) : [];
      } else if (!(role === 'admin' || role === 'hq_manager' || role === 'hr_manager' || role === 'store_manager')) {
        return res.status(403).json({ error: 'forbidden' });
      }
      if (!adminUsername) return res.status(500).json({ error: 'missing_admin' });
    }

    // try configured flow first
    const applicantStore = String(applicant?.store || '').trim();
    const ctx = {
      state,
      applicantUsername: username,
      applicantStore,
      managerUsername: applicantManager,
      adminUsername,
      hqManagerUsername,
      hrManagerUsername,
      cashierUsername
    };
    if (type === 'payment') {
      // Priority: approvalFlows.payment config (流程设置) > paymentFlowByStore > default
      const configured = buildApprovalAssigneesFromConfig(state, type, ctx);
      if (configured.length) {
        assignees = configured;
      } else {
        const store = String(payload?.store || '').trim();
        const flow = getPaymentFlowForStore(state, store);
        if (flow.approvers.length) {
          assignees = flow.approvers;
        } else {
          assignees = [applicantManager, cashierUsername, adminUsername].filter(Boolean);
        }
      }
    } else {
      const configured = buildApprovalAssigneesFromConfig(state, type, ctx);
      if (configured.length) {
        assignees = configured;
      } else {
        // default fallback per business flow specs
        if (type === 'leave') {
          // 休假: 直属上级 → 总部营运 → 人事经理
          assignees = [applicantManager, hqManagerUsername, hrManagerUsername].filter(Boolean);
        } else if (type === 'onboarding') {
          // 入职: 直属上级 → 人事经理 → 管理员
          assignees = [applicantManager, hrManagerUsername, adminUsername].filter(Boolean);
        } else if (type === 'offboarding') {
          // 离职: 直属上级 → 总部营运 → 人事经理
          assignees = [applicantManager, hqManagerUsername, hrManagerUsername].filter(Boolean);
        } else if (type === 'promotion') {
          // 晋升: 直属上级 → 总部营运 → 人事经理
          assignees = [applicantManager, hqManagerUsername, hrManagerUsername].filter(Boolean);
        } else if (type === 'reward_punishment') {
          // 奖惩: 直属上级 → 人事经理
          assignees = [applicantManager, hrManagerUsername].filter(Boolean);
        } else if (type === 'points') {
          // 积分: 直属上级 → 总部营运 → 人事经理
          assignees = [applicantManager, hqManagerUsername, hrManagerUsername].filter(Boolean);
        } else {
          assignees = [applicantManager, adminUsername].filter(Boolean);
        }
      }
    }

    const seen = new Set();
    const uniq = [];
    (assignees || []).forEach(a => {
      const k = String(a || '').trim().toLowerCase();
      if (!k || seen.has(k)) return;
      seen.add(k);
      uniq.push(String(a || '').trim());
    });
    if (!uniq.length) return res.status(400).json({ error: 'missing_assignee' });

    const chain = uniq.map((a, idx) => ({
      step: idx + 1,
      assignee: a,
      status: idx === 0 ? 'pending' : 'queued',
      decidedAt: null,
      note: ''
    }));

    const currentAssignee = chain[0]?.assignee || null;

    const r = await pool.query(
      `insert into approval_requests (type, status, applicant_username, current_assignee_username, chain, payload, created_at, updated_at)
       values ($1,$2,$3,$4,$5::jsonb,$6::jsonb, now(), now())
       returning id, type, status, applicant_username, current_assignee_username, chain, payload, effective_date, executed_at, created_at, updated_at`,
      [type, 'pending', username, currentAssignee, JSON.stringify(chain), JSON.stringify(payload)]
    );
    const item = r.rows?.[0] || null;

    try {
      if (item) {
        let nextState = state;
        const label = approvalTypeLabel(type);
        const title = `${label}申请待审批`;
        const applicantName = String(applicant?.name || username).trim() || username;

        let msg = `${applicantName} 提交了${label}申请，请审批。`;
        if (type === 'offboarding') {
          const resignDate = safeDateOnly(payload?.resignDate || payload?.date || payload?.resignationDate);
          if (resignDate) msg = `${applicantName} 提交了离职申请，期望离职日期：${resignDate}`;
        }
        if (type === 'leave') {
          const startDate = safeDateOnly(payload?.startDate || payload?.fromDate || payload?.beginDate);
          const endDate = safeDateOnly(payload?.endDate || payload?.toDate || payload?.finishDate);
          if (startDate && endDate) msg = `${applicantName} 提交了休假申请：${startDate} 至 ${endDate}`;
        }
        if (type === 'onboarding') {
          const emp = payload?.employee && typeof payload.employee === 'object' ? payload.employee : {};
          const empName = String(emp?.name || '').trim() || '新员工';
          msg = `${applicantName} 提交了新员工「${empName}」的入职申请，请审批。`;
        }
        if (type === 'promotion') {
          const newLevel = String(payload?.newLevel || payload?.level || '').trim();
          msg = `${applicantName} 提交了晋升申请${newLevel ? `（目标级别：${newLevel}）` : ''}，请审批。`;
        }
        if (type === 'reward_punishment') {
          const targetUser = String(payload?.targetUsername || payload?.employeeUsername || '').trim();
          const targetRec = targetUser ? (stateFindUserRecord(state, targetUser) || {}) : {};
          const targetName = String(targetRec?.name || targetUser).trim() || applicantName;
          const rpType = String(payload?.rpType || payload?.category || '').trim();
          msg = `${applicantName} 提交了${rpType || '奖惩'}申请（${targetName}），请审批。`;
        }
        if (type === 'points') {
          const itemName = String(payload?.itemName || '积分事项').trim();
          const points = safeNumber(payload?.points) || 0;
          msg = `${applicantName} 提交了积分申请（${itemName}，${points}分），请审批。`;
        }

        const recipients = uniqUsernames([currentAssignee]);
        for (const u of recipients) {
          nextState = addStateNotification(nextState, makeNotif(u, title, msg, { type: `${type}_request`, approvalId: item.id }));
        }
        await saveSharedState(nextState);
      }
    } catch (e) {}

    return res.json({ item, label: approvalTypeLabel(type) });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/approvals/:id/read', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const id = String(req.params?.id || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!id) return res.status(400).json({ error: 'missing_id' });
  try {
    await pool.query(
      `insert into user_reads (username, module, item_key, read_at)
       values ($1,$2,$3, now())
       on conflict (username, module, item_key) do update set read_at = excluded.read_at`,
      [username, 'approval', id]
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

// Admin delete approval record
app.delete('/api/approvals/:id', authRequired, async (req, res) => {
  const role = String(req.user?.role || '').trim();
  if (role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  const id = String(req.params?.id || '').trim();
  if (!id) return res.status(400).json({ error: 'missing_id' });
  try {
    const r = await pool.query('delete from approval_requests where id = $1 returning id, type', [id]);
    if (!r.rows?.length) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true, deleted: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/approvals/:id/decide', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const id = String(req.params?.id || '').trim();
  const approved = !!req.body?.approved;
  const note = String(req.body?.note || '').trim();
  const departureType = String(req.body?.departureType || '').trim(); // voluntary | involuntary
  const remainingLeaveDaysRaw = req.body?.remainingLeaveDays;
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!id) return res.status(400).json({ error: 'missing_id' });

  try {
    const r0 = await pool.query(
      'select id, type, status, applicant_username, current_assignee_username, chain, payload, effective_date, executed_at, created_at, updated_at from approval_requests where id = $1 limit 1',
      [id]
    );
    const row = r0.rows?.[0] || null;
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (String(row.status || '') !== 'pending') return res.status(400).json({ error: 'not_pending' });
    const chain = Array.isArray(row.chain) ? row.chain : [];
    const idx = chain.findIndex(x => String(x?.assignee || '').toLowerCase() === username.toLowerCase() && String(x?.status || '') === 'pending');
    if (idx < 0) return res.status(403).json({ error: 'forbidden' });

    const nowIso = new Date().toISOString();
    chain[idx] = { ...chain[idx], status: approved ? 'approved' : 'rejected', decidedAt: nowIso, note };

    let nextStatus = approved ? 'pending' : 'rejected';
    let nextAssignee = null;
    let effectiveDate = row.effective_date;
    let updatedPayload = row.payload && typeof row.payload === 'object' ? { ...row.payload } : {};

    // Save departureType into offboarding approval payload
    if (String(row.type || '') === 'offboarding' && departureType && (departureType === 'voluntary' || departureType === 'involuntary')) {
      updatedPayload.departureType = departureType;
    }

    // Save remainingLeaveDays into leave approval payload
    if (String(row.type || '') === 'leave' && remainingLeaveDaysRaw != null && remainingLeaveDaysRaw !== '') {
      const remDays = Number(remainingLeaveDaysRaw);
      if (Number.isFinite(remDays) && remDays >= 0) {
        updatedPayload.remainingLeaveDays = remDays;
        updatedPayload.remainingLeaveDaysFilledBy = username;
      }
    }

    if (approved) {
      const next = chain.slice(idx + 1).find(x => String(x?.status || '') === 'queued');
      if (next) {
        nextAssignee = String(next.assignee || '').trim() || null;
        const nextIdx = chain.findIndex(x => String(x?.assignee || '') === String(next.assignee || '') && String(x?.status || '') === 'queued');
        if (nextIdx >= 0) chain[nextIdx] = { ...chain[nextIdx], status: 'pending' };
      } else {
        nextStatus = 'approved';
        nextAssignee = null;
      }
    }

    if (nextStatus === 'approved' && String(row.type || '') === 'offboarding') {
      const resignDate = safeDateOnly(updatedPayload?.resignDate || updatedPayload?.date || updatedPayload?.resignationDate);
      if (resignDate) effectiveDate = resignDate;
    }

    const r1 = await pool.query(
      `update approval_requests
       set status=$2, current_assignee_username=$3, chain=$4::jsonb, effective_date=$5, payload=$6::jsonb, updated_at=now()
       where id=$1
       returning id, type, status, applicant_username, current_assignee_username, chain, payload, effective_date, executed_at, created_at, updated_at`,
      [id, nextStatus, nextAssignee, JSON.stringify(chain), effectiveDate || null, JSON.stringify(updatedPayload)]
    );
    const updated = r1.rows?.[0] || null;

    if (updated && String(updated.status || '') === 'approved' && String(updated.type || '') === 'onboarding') {
      let state = (await getSharedState()) || {};
      const employees = Array.isArray(state.employees) ? state.employees : [];
      const emp = updated.payload?.employee && typeof updated.payload.employee === 'object' ? updated.payload.employee : {};
      const newUsername = String(emp?.username || '').trim();
      if (newUsername && !stateFindUserRecord(state, newUsername)) {
        const nextEmployees = employees.slice();
        let empId = String(emp?.id || '').trim();
        if (!empId) {
          let maxNum = 0;
          employees.forEach(e => {
            const eid = String(e?.id || '').trim();
            const m = eid.match(/^(?:EMP)?(\d+)$/i);
            if (m) { const n = Number(m[1]); if (n > maxNum) maxNum = n; }
          });
          empId = String(maxNum + 1).padStart(4, '0');
        }
        const empPassword = String(emp?.password || '').trim() || '123456';
        const empName = String(emp?.name || '').trim() || newUsername;
        const nextEmp = {
          id: empId,
          username: newUsername,
          name: empName,
          password: empPassword,
          gender: String(emp?.gender || '').trim() || '',
          birthday: String(emp?.birthday || '').trim() || '',
          idCardNumber: String(emp?.idCardNumber || emp?.idCardNo || emp?.idNumber || '').trim() || '',
          hometown: String(emp?.hometown || '').trim() || '',
          registeredResidence: String(emp?.registeredResidence || '').trim() || '',
          maritalStatus: String(emp?.maritalStatus || '').trim() || '',
          wechat: String(emp?.wechat || '').trim() || '',
          store: String(emp?.store || '').trim() || '',
          role: String(emp?.role || '').trim() || 'store_employee',
          department: String(emp?.department || '').trim() || '',
          position: String(emp?.position || '').trim() || '',
          level: String(emp?.level || '').trim() || '',
          managerUsername: String(emp?.managerUsername || '').trim() || '',
          salary: emp?.salary == null ? '' : emp.salary,
          education: String(emp?.education || '').trim() || '',
          bankCard: String(emp?.bankCard || '').trim() || '',
          emergencyContactName: String(emp?.emergencyContactName || '').trim() || '',
          emergencyContactPhone: String(emp?.emergencyContactPhone || '').trim() || '',
          emergencyContactRelation: String(emp?.emergencyContactRelation || '').trim() || '',
          idCardFrontUrl: String(emp?.idCardFrontUrl || '').trim() || '',
          idCardBackUrl: String(emp?.idCardBackUrl || '').trim() || '',
          joinDate: String(emp?.joinDate || '').trim() || '',
          phone: String(emp?.phone || '').trim() || '',
          email: String(emp?.email || '').trim() || '',
          status: 'active',
          promotionHistory: Array.isArray(emp?.promotionHistory) ? emp.promotionHistory : [],
          createdAt: new Date().toISOString().slice(0, 10),
          lastLogin: null
        };
        nextEmployees.push(nextEmp);
        state = { ...state, employees: nextEmployees };

        // Notify submitter, direct manager, AND store manager of the employee's store
        const submitter = String(updated.applicant_username || '').trim();
        const empManager = String(nextEmp.managerUsername || '').trim();
        const empStore = String(nextEmp.store || '').trim();
        let storeManagerUsername = '';
        if (empStore) {
          const allEmps = Array.isArray(state.employees) ? state.employees : [];
          const smRec = allEmps.find(e => String(e?.store || '').trim() === empStore && String(e?.role || '').trim() === 'store_manager');
          if (smRec) storeManagerUsername = String(smRec.username || '').trim();
        }
        const title = '新员工入职审批已通过';
        const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '年').replace(/年(\d{2})$/, '月$1日');
        const submitterRec = stateFindUserRecord(state, submitter) || {};
        const submitterName = String(submitterRec?.name || submitter).trim() || submitter;
        const msg = `${submitterName}你好，你提交的新员工「${empName}」入职已经成功，该员工的系统账号是 ${newUsername}，密码是 ${empPassword}，请通知该员工上线吧！\n门店：${empStore || '-'}\n总部 ${todayStr}`;
        const recipients = uniqUsernames([submitter, empManager, storeManagerUsername].filter(Boolean));
        for (const u of recipients) {
          state = addStateNotification(state, makeNotif(u, title, msg, { type: 'onboarding_result', approvalId: updated.id }));
        }
        await saveSharedState(state);
      }
    }

    // Onboarding step notifications: notify next approver or submitter on rejection
    try {
      if (updated && String(updated.type || '') === 'onboarding') {
        const state0 = (await getSharedState()) || {};
        let stateN = state0;
        const applicantUser = String(updated.applicant_username || '').trim();
        const applicantRec = stateFindUserRecord(stateN, applicantUser) || {};
        const applicantName = String(applicantRec?.name || applicantUser).trim() || applicantUser;
        const empPayload = updated.payload?.employee && typeof updated.payload.employee === 'object' ? updated.payload.employee : {};
        const empName = String(empPayload?.name || '').trim() || '新员工';

        if (String(updated.status || '') === 'pending' && nextAssignee) {
          // Intermediate step approved, notify next approver
          const title = '新员工入职审批待处理';
          const msg = `${applicantName} 提交的新员工「${empName}」入职申请需要您审批。`;
          stateN = addStateNotification(stateN, makeNotif(nextAssignee, title, msg, { type: 'onboarding_request', approvalId: updated.id }));
          await saveSharedState(stateN);
        }

        if (String(updated.status || '') === 'rejected') {
          // Rejected, notify submitter
          const title = '新员工入职审批被拒绝';
          const msg = `新员工「${empName}」入职申请被拒绝${note ? `：${note}` : ''}`;
          stateN = addStateNotification(stateN, makeNotif(applicantUser, title, msg, { type: 'onboarding_result', approvalId: updated.id }));
          await saveSharedState(stateN);
        }
      }
    } catch (e) {}

    // --- Leave / Offboarding post-approval ---
    try {
      if (updated && (String(updated.type || '') === 'leave' || String(updated.type || '') === 'offboarding')) {
        const state0 = (await getSharedState()) || {};
        const applicant = stateFindUserRecord(state0, updated.applicant_username) || {};
        const applicantName = String(applicant?.name || updated.applicant_username).trim() || updated.applicant_username;
        const applicantManager = String(applicant?.managerUsername || '').trim();

        let state = state0;
        const tp = String(updated.type || '').trim();
        const label = approvalTypeLabel(tp);
        const finalApproved = String(updated.status || '') === 'approved';
        const finalRejected = String(updated.status || '') === 'rejected';

        if (finalApproved && tp === 'leave') {
          const startDate = safeDateOnly(updated.payload?.startDate || updated.payload?.fromDate || updated.payload?.beginDate);
          const endDate = safeDateOnly(updated.payload?.endDate || updated.payload?.toDate || updated.payload?.finishDate);
          const reason = String(updated.payload?.reason || updated.payload?.leaveReason || '').trim();
          const days = safeNumber(updated.payload?.days || updated.payload?.leaveDays);

          const rec = {
            id: randomUUID(),
            approvalId: String(updated.id || ''),
            applicant: String(updated.applicant_username || '').trim(),
            applicantName,
            managerUsername: applicantManager,
            store: String(applicant?.store || '').trim(),
            department: String(applicant?.department || '').trim(),
            position: String(applicant?.position || '').trim(),
            startDate,
            endDate,
            days: days == null ? '' : days,
            reason,
            createdAt: hrmsNowISO(),
            status: 'approved'
          };
          const list = Array.isArray(state.leaveRecords) ? state.leaveRecords.slice() : [];
          list.unshift(rec);
          state = { ...state, leaveRecords: list };

          // Format dates as X月X日
          const fmtLeaveDate = (d) => { if (!d) return ''; const p = String(d).split('-'); return p.length >= 3 ? `${Number(p[1])}月${Number(p[2])}日` : d; };
          const sd = fmtLeaveDate(startDate);
          const ed = fmtLeaveDate(endDate);
          // Notify applicant + direct supervisor
          const msg = `${applicantName}提交的休假申请${sd}至${ed}，已经审批通过。`;
          const recipients = uniqUsernames([updated.applicant_username, applicantManager].filter(Boolean));
          for (const u of recipients) {
            state = addStateNotification(state, makeNotif(u, '休假申请已通过', msg, { type: 'leave_result', approvalId: updated.id, leaveId: rec.id }));
          }
          await saveSharedState(state);
        }

        if (finalRejected && tp === 'leave') {
          const fmtLeaveDate2 = (d) => { if (!d) return ''; const p = String(d).split('-'); return p.length >= 3 ? `${Number(p[1])}月${Number(p[2])}日` : d; };
          const startDate2 = safeDateOnly(updated.payload?.startDate || updated.payload?.fromDate || updated.payload?.beginDate);
          const endDate2 = safeDateOnly(updated.payload?.endDate || updated.payload?.toDate || updated.payload?.finishDate);
          const sd2 = fmtLeaveDate2(startDate2);
          const ed2 = fmtLeaveDate2(endDate2);
          const msg = `${applicantName}提交的休假申请${sd2}至${ed2}，因为${note || '相关原因'}没有审批通过。`;
          const recipients = uniqUsernames([updated.applicant_username, applicantManager].filter(Boolean));
          for (const u of recipients) {
            state = addStateNotification(state, makeNotif(u, '休假申请未通过', msg, { type: 'leave_result', approvalId: updated.id }));
          }
          await saveSharedState(state);
        }

        // Intermediate step: notify next approver for leave
        if (String(updated.status || '') === 'pending' && nextAssignee && tp === 'leave') {
          const msg = `${applicantName} 提交了休假申请，需要您审批。`;
          state = addStateNotification(state, makeNotif(nextAssignee, '休假申请待审批', msg, { type: 'leave_request', approvalId: updated.id }));
          await saveSharedState(state);
        }

        if ((finalApproved || finalRejected) && tp === 'offboarding') {
          const resignDate = safeDateOnly(updated.payload?.resignDate || updated.payload?.date || updated.payload?.resignationDate);
          const title = finalApproved ? '离职申请已通过' : '离职申请被拒绝';
          const msg = finalApproved
            ? `${applicantName} 离职申请已通过，离职日期：${resignDate || '-'}。届时账号将自动禁用。`
            : `${applicantName} 离职申请被拒绝${note ? `：${note}` : ''}`;
          const recipients = finalApproved
            ? uniqUsernames([updated.applicant_username, applicantManager])
            : uniqUsernames([updated.applicant_username]);
          for (const u of recipients) {
            state = addStateNotification(state, makeNotif(u, title, msg, { type: 'offboarding_result', approvalId: updated.id }));
          }

          if (finalApproved) {
            const today = new Date().toISOString().slice(0, 10);
            const applicantUser = String(updated.applicant_username || '').trim();
            const employees = Array.isArray(state.employees) ? state.employees : [];
            const empIdx = employees.findIndex(e => String(e?.username || '').toLowerCase() === applicantUser.toLowerCase());
            if (empIdx >= 0) {
              const nextEmployees = employees.slice();
              nextEmployees[empIdx] = {
                ...nextEmployees[empIdx],
                offboardingApproved: true,
                offboardingDate: resignDate || today,
                status: '离职'
              };
              state = { ...state, employees: nextEmployees };
            }
            const users = Array.isArray(state.users) ? state.users : [];
            const userIdx = users.findIndex(u2 => String(u2?.username || '').toLowerCase() === applicantUser.toLowerCase());
            if (userIdx >= 0) {
              const nextUsers = users.slice();
              nextUsers[userIdx] = { ...nextUsers[userIdx], status: '离职' };
              state = { ...state, users: nextUsers };
            }
          }

          await saveSharedState(state);
        }

        // Intermediate step: notify next approver for offboarding
        if (String(updated.status || '') === 'pending' && nextAssignee && tp === 'offboarding') {
          const msg = `${applicantName} 提交了离职申请，需要您审批。`;
          state = addStateNotification(state, makeNotif(nextAssignee, '离职申请待审批', msg, { type: 'offboarding_request', approvalId: updated.id }));
          await saveSharedState(state);
        }
      }
    } catch (e) {}

    // --- Promotion post-approval ---
    try {
      if (updated && String(updated.type || '') === 'promotion') {
        const state0 = (await getSharedState()) || {};
        const applicantUser = String(updated.applicant_username || '').trim();
        const applicant = stateFindUserRecord(state0, applicantUser) || {};
        const applicantName = String(applicant?.name || applicantUser).trim() || applicantUser;
        const applicantManager = String(applicant?.managerUsername || '').trim();
        const finalApproved = String(updated.status || '') === 'approved';
        const finalRejected = String(updated.status || '') === 'rejected';
        let state = state0;

        if (finalApproved) {
          const newLevel = String(updated.payload?.newLevel || updated.payload?.level || '').trim();
          const newPosition = String(updated.payload?.newPosition || updated.payload?.position || '').trim();
          const promoReason = String(updated.payload?.reason || '').trim();

          // Update employee level/position and add promotion record
          const employees = Array.isArray(state.employees) ? state.employees : [];
          const empIdx = employees.findIndex(e => String(e?.username || '').toLowerCase() === applicantUser.toLowerCase());
          let oldLevel = '', oldPosition = '';
          if (empIdx >= 0) {
            const nextEmployees = employees.slice();
            oldLevel = String(nextEmployees[empIdx].level || '').trim();
            oldPosition = String(nextEmployees[empIdx].position || '').trim();
            const promoRecord = {
              date: new Date().toISOString().slice(0, 10),
              fromLevel: oldLevel,
              toLevel: newLevel || oldLevel,
              fromPosition: oldPosition,
              toPosition: newPosition || oldPosition,
              reason: promoReason,
              approvalId: String(updated.id || '')
            };
            const history = Array.isArray(nextEmployees[empIdx].promotionHistory) ? nextEmployees[empIdx].promotionHistory.slice() : [];
            history.push(promoRecord);
            nextEmployees[empIdx] = {
              ...nextEmployees[empIdx],
              level: newLevel || nextEmployees[empIdx].level,
              position: newPosition || nextEmployees[empIdx].position,
              promotionHistory: history
            };
            state = { ...state, employees: nextEmployees };
          }

          // Notify applicant + direct supervisor
          const msg = `${applicantName}，恭喜，你的晋升已经审批通过。`;
          const recipients = uniqUsernames([applicantUser, applicantManager].filter(Boolean));
          for (const u of recipients) {
            state = addStateNotification(state, makeNotif(u, '晋升申请已通过', msg, { type: 'promotion_result', approvalId: updated.id }));
          }
          await saveSharedState(state);
        }

        if (finalRejected) {
          // Notify applicant + direct supervisor
          const msg = `${applicantName}，你的晋升因为${note || '相关原因'}没有审批通过。`;
          const recipients = uniqUsernames([applicantUser, applicantManager].filter(Boolean));
          for (const u of recipients) {
            state = addStateNotification(state, makeNotif(u, '晋升申请未通过', msg, { type: 'promotion_result', approvalId: updated.id }));
          }
          await saveSharedState(state);
        }

        // Intermediate step: notify next approver
        if (String(updated.status || '') === 'pending' && nextAssignee) {
          const msg = `${applicantName} 提交了晋升申请，需要您审批。`;
          state = addStateNotification(state, makeNotif(nextAssignee, '晋升申请待审批', msg, { type: 'promotion_request', approvalId: updated.id }));
          await saveSharedState(state);
        }
      }
    } catch (e) {}

    // --- Reward/Punishment post-approval ---
    try {
      if (updated && String(updated.type || '') === 'reward_punishment') {
        const state0 = (await getSharedState()) || {};
        const applicantUser = String(updated.applicant_username || '').trim();
        const applicant = stateFindUserRecord(state0, applicantUser) || {};
        const applicantName = String(applicant?.name || applicantUser).trim() || applicantUser;
        const finalApproved = String(updated.status || '') === 'approved';
        const finalRejected = String(updated.status || '') === 'rejected';
        let state = state0;

        const targetUsername = String(updated.payload?.targetUsername || updated.payload?.employeeUsername || '').trim();
        const targetRec = targetUsername ? (stateFindUserRecord(state, targetUsername) || {}) : {};
        const targetName = String(targetRec?.name || targetUsername).trim() || targetUsername || applicantName;
        const rpType = String(updated.payload?.rpType || updated.payload?.category || '').trim();
        const amount = safeNumber(updated.payload?.amount);
        const rpReason = String(updated.payload?.reason || '').trim();
        const rpResult = String(updated.payload?.result || '').trim();
        const isReward = rpType === '奖励' || rpType === 'reward';
        const typeLabel = isReward ? '奖励' : '惩罚';

        if (finalApproved) {
          // Add to salary adjustment records
          const salaryAdj = {
            id: randomUUID(),
            approvalId: String(updated.id || ''),
            targetUsername: targetUsername || applicantUser,
            targetName,
            type: rpType || typeLabel,
            amount: Math.abs(amount || 0),
            signedAmount: isReward ? Math.abs(amount || 0) : -Math.abs(amount || 0),
            reason: rpReason,
            result: rpResult,
            applicantUsername: applicantUser,
            applicantName,
            createdAt: hrmsNowISO(),
            status: 'approved'
          };
          const adjList = Array.isArray(state.salaryAdjustments) ? state.salaryAdjustments.slice() : [];
          adjList.unshift(salaryAdj);
          state = { ...state, salaryAdjustments: adjList };

          // Notify target person (the one being rewarded/punished)
          if (targetUsername) {
            const msgTarget = isReward
              ? `${targetName}，由于${rpReason || '工作表现优秀'}原因，本月你会收到${amount || 0}元的奖励，继续努力哦！`
              : `${targetName}，由于${rpReason || '相关原因'}原因，本月你会收到${amount || 0}元的处罚，希望可以加油改进！`;
            state = addStateNotification(state, makeNotif(targetUsername, `${typeLabel}通知`, msgTarget, { type: 'reward_punishment_result', approvalId: updated.id }));
          }
          // Notify initiator (applicant)
          const msgApplicant = isReward
            ? `${targetName}的奖励申请已审批通过，金额${amount || 0}元已计入薪资表。`
            : `${targetName}的处罚申请已审批通过，金额${amount || 0}元已计入薪资表。`;
          state = addStateNotification(state, makeNotif(applicantUser, `${typeLabel}申请已通过`, msgApplicant, { type: 'reward_punishment_result', approvalId: updated.id }));
          await saveSharedState(state);
        }

        if (finalRejected) {
          const msg = `对${targetName}的${typeLabel}申请因为${note || '相关原因'}没有审批通过。`;
          state = addStateNotification(state, makeNotif(applicantUser, `${typeLabel}申请未通过`, msg, { type: 'reward_punishment_result', approvalId: updated.id }));
          await saveSharedState(state);
        }

        // Intermediate step: notify next approver
        if (String(updated.status || '') === 'pending' && nextAssignee) {
          const msg = `${applicantName} 提交了${typeLabel}申请（${targetName}），需要您审批。`;
          state = addStateNotification(state, makeNotif(nextAssignee, `${typeLabel}申请待审批`, msg, { type: 'reward_punishment_request', approvalId: updated.id }));
          await saveSharedState(state);
        }
      }
    } catch (e) {}

    // --- Points post-approval ---
    try {
      if (updated && String(updated.type || '') === 'points') {
        const state0 = (await getSharedState()) || {};
        const applicantUser = String(updated.applicant_username || '').trim();
        const applicant = stateFindUserRecord(state0, applicantUser) || {};
        const applicantName = String(applicant?.name || applicantUser).trim() || applicantUser;
        const applicantManager = String(applicant?.managerUsername || '').trim();
        const finalApproved = String(updated.status || '') === 'approved';
        const finalRejected = String(updated.status || '') === 'rejected';
        let state = state0;

        const itemName = String(updated.payload?.itemName || '积分事项').trim();
        const reasonText = String(updated.payload?.reason || '').trim();
        const points = safeNumber(updated.payload?.points) || 0;
        const store = String(updated.payload?.store || applicant?.store || '').trim();
        const month = String(updated.created_at || updated.updated_at || '').slice(0, 7) || new Date().toISOString().slice(0, 7);
        const subsidyAmount = Number((points * 0.5).toFixed(2));

        if (finalApproved) {
          const appliedMap = state?.pointsAppliedApprovals && typeof state.pointsAppliedApprovals === 'object'
            ? { ...state.pointsAppliedApprovals }
            : {};
          const approvalId = String(updated.id || '').trim();
          if (!appliedMap[approvalId]) {
            const records = Array.isArray(state.pointRecords) ? state.pointRecords.slice() : [];
            records.unshift({
              id: randomUUID(),
              approvalId,
              username: applicantUser,
              name: applicantName,
              store,
              itemName,
              reason: reasonText,
              points,
              amount: subsidyAmount,
              approvedAt: hrmsNowISO(),
              approvedBy: String(req.user?.username || '').trim()
            });

            const payrollAdjustments = state?.payrollAdjustments && typeof state.payrollAdjustments === 'object'
              ? { ...state.payrollAdjustments }
              : {};
            const adjKey = `${month}||${store || 'ALL'}||${applicantUser.toLowerCase()}`;
            const prev = payrollAdjustments[adjKey] && typeof payrollAdjustments[adjKey] === 'object' ? payrollAdjustments[adjKey] : {};
            const prevSubsidy = safeNumber(prev?.subsidy) || 0;
            payrollAdjustments[adjKey] = {
              ...prev,
              month,
              store: store || '',
              username: applicantUser,
              subsidy: Number((prevSubsidy + subsidyAmount).toFixed(2)),
              updatedBy: String(req.user?.username || '').trim(),
              updatedAt: hrmsNowISO(),
              source: 'points'
            };

            appliedMap[approvalId] = true;
            state = { ...state, pointRecords: records, payrollAdjustments, pointsAppliedApprovals: appliedMap };
          }

          const msg = `${applicantName}，你申请的“${itemName}”已通过审批，获得${points}积分（折算¥${subsidyAmount.toFixed(2)}，已计入薪资补贴）。`;
          const recipients = uniqUsernames([applicantUser, applicantManager].filter(Boolean));
          for (const u of recipients) {
            state = addStateNotification(state, makeNotif(u, '积分申请已通过', msg, { type: 'points_result', approvalId: updated.id }));
          }
          await saveSharedState(state);
        }

        if (finalRejected) {
          const msg = `${applicantName}，你申请的“${itemName}”因为${note || '相关原因'}未通过审批。`;
          const recipients = uniqUsernames([applicantUser, applicantManager].filter(Boolean));
          for (const u of recipients) {
            state = addStateNotification(state, makeNotif(u, '积分申请未通过', msg, { type: 'points_result', approvalId: updated.id }));
          }
          await saveSharedState(state);
        }

        if (String(updated.status || '') === 'pending' && nextAssignee) {
          const msg = `${applicantName} 提交了积分申请（${itemName}，${points}分），需要您审批。`;
          state = addStateNotification(state, makeNotif(nextAssignee, '积分申请待审批', msg, { type: 'points_request', approvalId: updated.id }));
          await saveSharedState(state);
        }
      }
    } catch (e) {}

    // --- Monthly confirm post-approval ---
    try {
      if (updated && String(updated.type || '') === 'monthly_confirm') {
        const state0 = (await getSharedState()) || {};
        const applicantUser = String(updated.applicant_username || '').trim();
        const applicant = stateFindUserRecord(state0, applicantUser) || {};
        const applicantName = String(applicant?.name || applicantUser).trim() || applicantUser;
        const payload = typeof updated.payload === 'string' ? JSON.parse(updated.payload) : (updated.payload || {});
        const confirmationId = String(payload?.confirmationId || '').trim();
        const mcMonth = String(payload?.month || '').trim();
        const mcStore = String(payload?.store || '').trim();

        if (String(updated.status || '') === 'approved' && confirmationId) {
          let state = state0;
          const confirmations = Array.isArray(state.monthlyConfirmations) ? state.monthlyConfirmations : [];
          const mc = confirmations.find(c => c.id === confirmationId);
          if (mc) {
            mc.status = 'approved';
            mc.approvedAt = new Date().toISOString();
            mc.history = mc.history || [];
            mc.history.push({ action: 'approved', by: 'system', at: new Date().toISOString() });
          }
          state.monthlyConfirmations = confirmations;

          // Notify submitter
          const msg = `${mcMonth} ${mcStore || '全部门店'} 的月度考勤确认已通过审批。工资数据将自动生成。`;
          state = addStateNotification(state, makeNotif(applicantUser, '月度考勤确认已通过', msg, { type: 'monthly_confirm_result', approvalId: updated.id }));
          await saveSharedState(state);
        }

        if (String(updated.status || '') === 'rejected' && confirmationId) {
          let state = state0;
          const confirmations = Array.isArray(state.monthlyConfirmations) ? state.monthlyConfirmations : [];
          const mc = confirmations.find(c => c.id === confirmationId);
          if (mc) {
            mc.status = 'rejected';
            mc.history = mc.history || [];
            mc.history.push({ action: 'rejected', by: String(req.user?.username || ''), at: new Date().toISOString(), note });
          }
          state.monthlyConfirmations = confirmations;
          const msg = `${mcMonth} ${mcStore || '全部门店'} 的月度考勤确认被驳回${note ? `：${note}` : ''}`;
          state = addStateNotification(state, makeNotif(applicantUser, '月度考勤确认被驳回', msg, { type: 'monthly_confirm_result', approvalId: updated.id }));
          await saveSharedState(state);
        }

        // Intermediate step: notify next approver
        if (String(updated.status || '') === 'pending' && nextAssignee) {
          let state = state0;
          const msg = `${applicantName} 提交了 ${mcMonth} ${mcStore || '全部门店'} 的月度考勤确认，需要您审批。`;
          state = addStateNotification(state, makeNotif(nextAssignee, '月度考勤确认待审批', msg, { type: 'monthly_confirm_request', approvalId: updated.id }));
          await saveSharedState(state);
        }
      }
    } catch (e) { console.error('monthly_confirm post-approval error:', e); }

    // --- Generic intermediate step notifications for leave/offboarding ---
    try {
      if (updated && (String(updated.type || '') === 'leave' || String(updated.type || '') === 'offboarding')) {
        if (String(updated.status || '') === 'pending' && nextAssignee) {
          const state0 = (await getSharedState()) || {};
          const applicant = stateFindUserRecord(state0, updated.applicant_username) || {};
          const applicantName = String(applicant?.name || updated.applicant_username).trim() || updated.applicant_username;
          const label = approvalTypeLabel(String(updated.type || ''));
          const msg = `${applicantName} 提交了${label}申请，需要您审批。`;
          let stateN = state0;
          stateN = addStateNotification(stateN, makeNotif(nextAssignee, `${label}申请待审批`, msg, { type: `${updated.type}_request`, approvalId: updated.id }));
          await saveSharedState(stateN);
        }
      }
    } catch (e) {}

    return res.json({ item: updated });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/payments/:id/pay', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  const id = String(req.params?.id || '').trim();
  const note = String(req.body?.note || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!id) return res.status(400).json({ error: 'missing_id' });
  if (!(role === 'admin' || role === 'hq_manager' || role === 'hr_manager' || role === 'cashier')) return res.status(403).json({ error: 'forbidden' });

  try {
    const r0 = await pool.query(
      'select id, type, status, payload from approval_requests where id = $1 limit 1',
      [id]
    );
    const row = r0.rows?.[0] || null;
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (String(row.type || '') !== 'payment') return res.status(400).json({ error: 'invalid_type' });
    if (String(row.status || '') !== 'approved') return res.status(400).json({ error: 'not_approved' });

    const nowIso = new Date().toISOString();
    const nextPayload = {
      ...(row.payload && typeof row.payload === 'object' ? row.payload : {}),
      paidAt: nowIso,
      paidBy: username,
      payNote: note
    };

    const r1 = await pool.query(
      `update approval_requests
       set status = 'paid', payload = $2::jsonb, executed_at = now(), updated_at = now()
       where id = $1
       returning id, type, status, applicant_username, current_assignee_username, chain, payload, effective_date, executed_at, created_at, updated_at`,
      [id, JSON.stringify(nextPayload)]
    );
    return res.json({ item: r1.rows?.[0] || null });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/payments/export', authRequired, async (req, res) => {
  const role = String(req.user?.role || '').trim();
  if (role !== 'admin') return res.status(403).json({ error: 'forbidden' });

  const start = safeDateOnly(req.query?.start);
  const end = safeDateOnly(req.query?.end);
  if (!start || !end) return res.status(400).json({ error: 'missing_date_range' });

  try {
    const r = await pool.query(
      `select id, status, applicant_username, created_at, updated_at, executed_at, payload
       from approval_requests
       where type = 'payment'
         and (payload->>'date') >= $1
         and (payload->>'date') <= $2
       order by (payload->>'date') desc, created_at desc`,
      [start, end]
    );
    const rows = r.rows || [];

    const esc = (v) => {
      const s = String(v == null ? '' : v);
      const out = s.replace(/"/g, '""');
      return '"' + out + '"';
    };
    const headers = ['id', 'date', 'store', 'category', 'amount', 'payee', 'urgency', 'status', 'applicant', 'created_at', 'paid_at', 'paid_by', 'note', 'pay_note'];
    const lines = [headers.join(',')];
    for (const it of rows) {
      const p = it?.payload && typeof it.payload === 'object' ? it.payload : {};
      lines.push([
        esc(it?.id),
        esc(p?.date),
        esc(p?.store),
        esc(p?.category),
        esc(p?.amount),
        esc(p?.payee),
        esc(p?.urgency),
        esc(it?.status),
        esc(it?.applicant_username),
        esc(it?.created_at),
        esc(p?.paidAt || it?.executed_at),
        esc(p?.paidBy),
        esc(p?.note),
        esc(p?.payNote)
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payments_${start}_${end}.csv"`);
    return res.send('\ufeff' + lines.join('\n'));
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

// ─── Attendance / Checkin APIs ───────────────────────────────────────────────

app.post('/api/checkin', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  const type = String(req.body?.type || 'clock_in').trim();
  if (type !== 'clock_in' && type !== 'clock_out') return res.status(400).json({ error: 'invalid_type' });
  const lat = Number(req.body?.latitude) || 0;
  const lng = Number(req.body?.longitude) || 0;
  const noGps = !!req.body?.noGps;
  const faceMatch = !!req.body?.faceMatch;
  const faceScore = Number(req.body?.faceScore) || 0;
  const photoUrl = req.body?.photoUrl ? String(req.body.photoUrl) : null;
  const storeName = String(req.body?.store || req.user?.store || '').trim();

  try {
    let distMeters = null;
    let status = 'normal';

    if (noGps || (lat === 0 && lng === 0)) {
      status = 'no_gps';
    } else if (storeName) {
      // Look up store location
      try {
        const sr = await pool.query("select data from hrms_state where key = 'default' limit 1");
        const state = sr.rows?.[0]?.data || {};
        const stores = Array.isArray(state.stores) ? state.stores : [];
        const store = stores.find(s => String(s?.name || '') === storeName);
        const sLat = Number(store?.latitude || store?.location?.latitude || 0);
        const sLng = Number(store?.longitude || store?.location?.longitude || 0);
        if (sLat && sLng) {
          distMeters = haversineDistance(lat, lng, sLat, sLng);
          if (distMeters > 500) status = 'out_of_range';
        } else {
          status = 'no_store_location';
        }
      } catch (e) {
        status = 'no_store_location';
      }
    }

    if (!faceMatch && status === 'normal') status = 'face_fail';

    const r = await pool.query(
      `insert into checkin_records (username, store, type, check_time, latitude, longitude, distance_meters, face_match, face_score, photo_url, status)
       values ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9, $10)
       returning *`,
      [username, storeName || null, type, lat, lng, distMeters, faceMatch, faceScore, photoUrl, status]
    );
    return res.json({ ok: true, record: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

// NOTE: /api/checkin/today, /api/checkin/records, /api/checkin/summary handlers
// are defined later in this file (using shared state for name resolution).

// NOTE: /api/checkin/monthly-confirm and /api/checkin/leave-balance handlers
// are defined later in this file (using shared state).

// ─── End Attendance APIs (first block) ──────────────────────────────────────

app.post('/api/reads/batch', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const module = String(req.body?.module || '').trim();
  const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(x => String(x || '').trim()).filter(Boolean) : [];
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!module) return res.status(400).json({ error: 'missing_module' });
  if (!keys.length) return res.json({ ok: true, inserted: 0 });

  const sliced = keys.slice(0, 500);
  try {
    const values = [];
    const params = [];
    sliced.forEach((k, i) => {
      params.push(username, module, k);
      const base = i * 3;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, now())`);
    });
    await pool.query(
      `insert into user_reads (username, module, item_key, read_at)
       values ${values.join(',')}
       on conflict (username, module, item_key) do update set read_at = excluded.read_at`,
      params
    );
    return res.json({ ok: true, inserted: sliced.length });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/unread-counts', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });

  try {
    const readsR = await pool.query('select module, item_key from user_reads where username = $1', [username]);
    const readMap = new Map();
    (readsR.rows || []).forEach(r => {
      const m = String(r?.module || '').trim();
      const k = String(r?.item_key || '').trim();
      if (!m || !k) return;
      if (!readMap.has(m)) readMap.set(m, new Set());
      readMap.get(m).add(k);
    });

    const approvalsUnreadR = await pool.query(
      `select count(*)::int as cnt
       from approval_requests ar
       left join user_reads ur
         on ur.username = $1 and ur.module = 'approval' and ur.item_key = ar.id::text
       where ar.status = 'pending'
         and lower(ar.current_assignee_username) = lower($1)
         and ur.item_key is null`,
      [username]
    );
    const approvals = approvalsUnreadR.rows?.[0]?.cnt || 0;

    const state = (await getSharedState()) || {};
    const me = stateFindUserRecord(state, username) || {};
    const myStore = String(me?.store || '').trim();
    const myDept = String(me?.department || '').trim();
    const myPos = String(me?.position || '').trim();

    const isRead = (module, key) => {
      const s = readMap.get(module);
      return s ? s.has(String(key || '').trim()) : false;
    };

    const tasks = Array.isArray(state.trainingTasks) ? state.trainingTasks : [];
    let training = 0;
    for (const t of tasks) {
      const id = String(t?.id || '').trim();
      if (!id) continue;
      if (String(t?.status || '') === 'cancelled') continue;
      const scope = t?.scope && typeof t.scope === 'object' ? t.scope : {};
      const scopeType = String(scope?.type || '').trim();
      const matchScope =
        scopeType === 'all' ||
        (scopeType === 'store' && String(scope?.store || '').trim() && String(scope.store).trim() === myStore) ||
        (scopeType === 'department' && String(scope?.department || '').trim() && String(scope.department).trim() === myDept) ||
        (scopeType === 'user' && String(scope?.user || '').trim() && String(scope.user).trim() === username);

      const assignedTo = String(t?.assignedTo || '').trim();
      const assignedUsers = Array.isArray(t?.assignedUsers) ? t.assignedUsers.map(x => String(x || '').trim()) : [];
      const matchAssigned = assignedTo === username || assignedUsers.includes(username);
      if (!matchScope && !matchAssigned) continue;
      if (isRead('training', id)) continue;
      training += 1;
    }

    const assignments = Array.isArray(state.examAssignments) ? state.examAssignments : [];
    const toArr = (v) => {
      if (Array.isArray(v)) return v.map(x => String(x || '').trim()).filter(Boolean);
      const s = String(v || '').trim();
      return s ? [s] : [];
    };
    let exam = 0;
    for (const a of assignments) {
      const id = String(a?.id || '').trim();
      if (!id) continue;
      const scope = a?.scope && typeof a.scope === 'object' ? a.scope : (a?.audience && typeof a.audience === 'object' ? a.audience : {});
      const t = String(scope?.type || 'all').trim();
      let match = true;
      if (t === 'store') match = toArr(scope?.stores || scope?.store || scope?.value).includes(myStore);
      if (t === 'position') match = toArr(scope?.positions || scope?.position || scope?.value).includes(myPos);
      if (t === 'user') match = toArr(scope?.users || scope?.user || scope?.value).includes(username);
      if (!match) continue;
      if (isRead('exam', id)) continue;
      exam += 1;
    }

    const notifications = Array.isArray(state.notifications) ? state.notifications : [];
    let dashboard = 0;
    for (const n of notifications) {
      const key = String(n?.id || '').trim();
      if (!key) continue;

      const targetUser = String(n?.targetUser || '').trim();
      if (targetUser) {
        if (targetUser !== username) continue;
      } else {
        const scope = n?.scope && typeof n.scope === 'object' ? n.scope : null;
        const t = String(scope?.type || 'all').trim();
        if (t === 'all') {
          // visible
        } else if (t === 'store') {
          if (String(scope?.store || '').trim() !== myStore) continue;
        } else if (t === 'position') {
          if (String(scope?.position || '').trim() !== myPos) continue;
        } else if (t === 'user') {
          const list = Array.isArray(scope?.usernames) ? scope.usernames.map(x => String(x || '').trim()) : [];
          if (!list.includes(username)) continue;
        } else {
          continue;
        }
      }

      if (isRead('dashboard', key)) continue;
      dashboard += 1;
    }

    // rewards: unread reward_punishment records for this user
    let rewards = 0;
    try {
      const rwR = await pool.query(
        `SELECT count(*)::int as cnt
         FROM approval_requests ar
         LEFT JOIN user_reads ur
           ON ur.username = $1 AND ur.module = 'rewards' AND ur.item_key = ar.id::text
         WHERE ar.type = 'reward_punishment'
           AND ar.status IN ('approved','paid')
           AND (ar.payload->>'targetUser' = $1 OR ar.submitted_by = $1)
           AND ur.item_key IS NULL`,
        [username]
      );
      rewards = rwR.rows?.[0]?.cnt || 0;
    } catch (e) {}

    // payment: unread payment records for this user
    let payment = 0;
    try {
      const pmR = await pool.query(
        `SELECT count(*)::int as cnt
         FROM approval_requests ar
         LEFT JOIN user_reads ur
           ON ur.username = $1 AND ur.module = 'payment' AND ur.item_key = ar.id::text
         WHERE ar.type = 'payment'
           AND ar.status = 'pending'
           AND (lower(ar.current_assignee_username) = lower($1) OR lower(ar.submitted_by) = lower($1))
           AND ur.item_key IS NULL`,
        [username]
      );
      payment = pmR.rows?.[0]?.cnt || 0;
    } catch (e) {}

    return res.json({ approvals, training, exam, dashboard, rewards, payment });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});
app.use('/uploads', express.static(uploadsDir));

const webRootDir = path.resolve(__dirname, '..');
app.use(
  express.static(webRootDir, {
    index: false,
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      const lp = String(filePath || '').toLowerCase();
      if (lp.endsWith('.html') || lp.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
      }
    }
  })
);

app.get('/', (req, res) => {
  const p1 = path.join(webRootDir, 'working-fixed.html');
  const p2 = path.join(webRootDir, 'index.html');
  const target = fs.existsSync(p1) ? p1 : (fs.existsSync(p2) ? p2 : null);
  if (!target) return res.status(404).send('Missing frontend html');
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(target);
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const st = ensureUploadsDir();
      if (!st.ok) return cb(new Error('uploads_dir_not_writable: ' + String(st.error || 'unknown')));
      return cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
      const orig = String(file?.originalname || 'file');
      const ext = path.extname(orig).slice(0, 16);
      cb(null, `${randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 1024 * 1024 * 1024 }
});

const knowledgeUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const st = ensureUploadsDir();
      if (!st.ok) return cb(new Error('uploads_dir_not_writable: ' + String(st.error || 'unknown')));
      return cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
      const orig = String(file?.originalname || 'file');
      const ext = path.extname(orig).slice(0, 16);
      cb(null, `${randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 300 * 1024 * 1024 }
});

app.post('/api/uploads/daily-report', authRequired, upload.array('files', 9), async (req, res) => {
  const role = String(req.user?.role || '').trim();
  if (role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ error: 'missing_file' });
    const urls = files
      .map(f => (f && f.filename ? `/uploads/${f.filename}` : ''))
      .filter(Boolean);
    return res.json({ urls });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/uploads/employee-idcard', authRequired, upload.fields([{ name: 'front', maxCount: 1 }, { name: 'back', maxCount: 1 }]), async (req, res) => {
  const role = String(req.user?.role || '').trim();
  if (!(role === 'admin' || role === 'store_manager' || role === 'hr_manager')) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    const files = req.files && typeof req.files === 'object' ? req.files : {};
    const front = Array.isArray(files.front) ? files.front[0] : null;
    const back = Array.isArray(files.back) ? files.back[0] : null;
    if (!front && !back) return res.status(400).json({ error: 'missing_file' });
    const frontUrl = front?.filename ? `/uploads/${front.filename}` : '';
    const backUrl = back?.filename ? `/uploads/${back.filename}` : '';
    return res.json({ frontUrl, backUrl });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/uploads/points-evidence', authRequired, upload.array('files', 6), async (req, res) => {
  const role = String(req.user?.role || '').trim();
  if (!canApplyPointsByRole(role)) return res.status(403).json({ error: 'forbidden' });
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ error: 'missing_file' });
    const urls = files
      .map(f => (f && f.filename ? `/uploads/${f.filename}` : ''))
      .filter(Boolean);
    return res.json({ urls });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

const pool = new Pool({ connectionString: DATABASE_URL });

async function hasColumn(tableName, columnName) {
  const t = String(tableName || '').trim();
  const c = String(columnName || '').trim();
  if (!t || !c) return false;
  const r = await pool.query(
    `select 1
     from information_schema.columns
     where table_schema = 'public'
       and table_name = $1
       and column_name = $2
     limit 1`,
    [t, c]
  );
  return (r.rows || []).length > 0;
}

async function ensureHrmsStateTable() {
  try {
    await pool.query(
      `create table if not exists hrms_state (
        key text primary key,
        data jsonb not null,
        updated_at timestamp default current_timestamp
      )`
    );
  } catch (e) {
    console.error('ensureHrmsStateTable failed:', e);
  }
}

async function ensureApprovalTables() {
  try {
    await pool.query('create extension if not exists pgcrypto');
    await pool.query(
      `create table if not exists approval_requests (
        id uuid primary key default gen_random_uuid(),
        type varchar(50) not null,
        status varchar(20) not null,
        applicant_username varchar(100) not null,
        current_assignee_username varchar(100),
        chain jsonb not null default '[]'::jsonb,
        payload jsonb not null default '{}'::jsonb,
        effective_date date,
        executed_at timestamp,
        created_at timestamp default current_timestamp,
        updated_at timestamp default current_timestamp
      )`
    );
    await pool.query(`create index if not exists idx_approval_requests_assignee_status on approval_requests (current_assignee_username, status)`);
    await pool.query(`create index if not exists idx_approval_requests_applicant_status on approval_requests (applicant_username, status)`);
    await pool.query(`create index if not exists idx_approval_requests_type_effective_date on approval_requests (type, effective_date)`);
  } catch (e) {
    console.error('ensureApprovalTables failed:', e);
  }
}

async function ensureUserSessionsTable() {
  try {
    await pool.query(
      `create table if not exists user_sessions (
        username varchar(100) primary key,
        session_nonce varchar(64) not null,
        updated_at timestamp default current_timestamp
      )`
    );
  } catch (e) {
    console.error('ensureUserSessionsTable failed:', e);
  }
}

async function ensureUserReadsTable() {
  try {
    await pool.query(
      `create table if not exists user_reads (
        username varchar(100) not null,
        module varchar(50) not null,
        item_key varchar(160) not null,
        read_at timestamp default current_timestamp,
        primary key (username, module, item_key)
      )`
    );
    await pool.query(`create index if not exists idx_user_reads_username_module on user_reads (username, module)`);
  } catch (e) {
    console.error('ensureUserReadsTable failed:', e);
  }
}

async function ensureCheckinTable() {
  try {
    await pool.query('create extension if not exists pgcrypto');
    await pool.query(
      `create table if not exists checkin_records (
        id uuid primary key default gen_random_uuid(),
        username varchar(100) not null,
        store varchar(200),
        type varchar(20) not null default 'clock_in',
        check_time timestamp not null default current_timestamp,
        latitude double precision,
        longitude double precision,
        distance_meters double precision,
        face_match boolean default false,
        face_score double precision,
        photo_url text,
        status varchar(20) not null default 'normal',
        note text,
        confirmed_by varchar(100),
        confirmed_at timestamp,
        created_at timestamp default current_timestamp
      )`
    );
    await pool.query(`create index if not exists idx_checkin_username_time on checkin_records (username, check_time)`);
    await pool.query(`create index if not exists idx_checkin_store_time on checkin_records (store, check_time)`);
  } catch (e) {
    console.error('ensureCheckinTable failed:', e);
  }
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const LEGACY_TEST_USERNAMES = new Set(['store_emp1', 'store_prod1', 'store_mgr1', 'hq_mgr1', 'emp1']);
const LEGACY_TEST_EMPLOYEE_IDS = new Set(['EMP001', 'EMP004']);

function isLegacyTestUsername(input) {
  const u = String(input || '').trim().toLowerCase();
  return !!u && LEGACY_TEST_USERNAMES.has(u);
}

function cleanupLegacyTestState(state0) {
  const state = state0 && typeof state0 === 'object' ? { ...state0 } : {};
  let changed = false;

  const users = Array.isArray(state.users) ? state.users : [];
  const nextUsers = users.filter(u => !isLegacyTestUsername(u?.username));
  if (nextUsers.length !== users.length) {
    state.users = nextUsers;
    changed = true;
  }

  const employees = Array.isArray(state.employees) ? state.employees : [];
  const nextEmployees = employees.filter(e => {
    if (isLegacyTestUsername(e?.username)) return false;
    const id = String(e?.id || '').trim().toUpperCase();
    return !LEGACY_TEST_EMPLOYEE_IDS.has(id);
  });
  if (nextEmployees.length !== employees.length) {
    state.employees = nextEmployees;
    changed = true;
  }

  const pointRecords = Array.isArray(state.pointRecords) ? state.pointRecords : [];
  const nextPointRecords = pointRecords.filter(r => !isLegacyTestUsername(r?.username));
  if (nextPointRecords.length !== pointRecords.length) {
    state.pointRecords = nextPointRecords;
    changed = true;
  }

  const salaryAdjustments = Array.isArray(state.salaryAdjustments) ? state.salaryAdjustments : [];
  const nextSalaryAdjustments = salaryAdjustments.filter(r => !isLegacyTestUsername(r?.targetUsername) && !isLegacyTestUsername(r?.applicantUsername));
  if (nextSalaryAdjustments.length !== salaryAdjustments.length) {
    state.salaryAdjustments = nextSalaryAdjustments;
    changed = true;
  }

  const payrollAdjustments = state.payrollAdjustments && typeof state.payrollAdjustments === 'object' ? state.payrollAdjustments : {};
  const nextPayrollAdjustments = {};
  Object.entries(payrollAdjustments).forEach(([k, v]) => {
    const key = String(k || '').trim();
    const m = key.match(/^\d{4}-\d{2}\|\|.+\|\|(.+)$/);
    const keyUser = m ? String(m[1] || '').trim() : '';
    const valueUser = String(v?.username || '').trim();
    if (isLegacyTestUsername(keyUser) || isLegacyTestUsername(valueUser)) {
      changed = true;
      return;
    }
    nextPayrollAdjustments[key] = v;
  });
  state.payrollAdjustments = nextPayrollAdjustments;

  return { state, changed };
}

async function getSharedState() {
  const r = await pool.query('select data from hrms_state where key = $1 limit 1', ['default']);
  const row = r.rows?.[0] || null;
  return row?.data && typeof row.data === 'object' ? row.data : null;
}

async function saveSharedState(nextData) {
  await pool.query(
    `insert into hrms_state (key, data, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key) do update set data = excluded.data, updated_at = now()`,
    ['default', JSON.stringify(nextData || {})]
  );
}

function stateFindUserRecord(state, username) {
  const u = String(username || '').trim();
  if (!u) return null;
  const users = Array.isArray(state?.users) ? state.users : [];
  const employees = Array.isArray(state?.employees) ? state.employees : [];
  // employees first – real users live there
  const all = employees.concat(users);
  return all.find(x => String(x?.username || '').trim().toLowerCase() === u.toLowerCase()) || null;
}

async function pickAdminUsername(state) {
  const users = Array.isArray(state?.users) ? state.users : [];
  const employees = Array.isArray(state?.employees) ? state.employees : [];
  // employees first – real users live there
  const all = employees.concat(users);
  const fromState = all.find(x => String(x?.role || '').trim() === 'admin')?.username;
  if (fromState) return String(fromState).trim();

  try {
    const r = await pool.query("select username from users where role = 'admin' and is_active = true order by created_at asc limit 1");
    const row = r.rows?.[0] || null;
    if (row?.username) return String(row.username).trim();
  } catch (e) {}

  return 'admin';
}

async function pickHqManagerUsername(state) {
  const users = Array.isArray(state?.users) ? state.users : [];
  const employees = Array.isArray(state?.employees) ? state.employees : [];
  // employees first – real users live there; users may contain stale test accounts
  const all = employees.concat(users);
  const fromState = all.find(x => String(x?.role || '').trim() === 'hq_manager' && String(x?.status || '').trim() !== '离职' && String(x?.status || '').trim() !== 'inactive')?.username;
  if (fromState) return String(fromState).trim();

  try {
    const r = await pool.query("select username from users where role = 'hq_manager' and is_active = true order by created_at asc limit 1");
    const row = r.rows?.[0] || null;
    if (row?.username) return String(row.username).trim();
  } catch (e) {}

  return '';
}

async function pickHrManagerUsername(state) {
  const users = Array.isArray(state?.users) ? state.users : [];
  const employees = Array.isArray(state?.employees) ? state.employees : [];
  // employees first – real users live there
  const all = employees.concat(users);
  const hrRoles = ['hr_manager', 'custom_人事经理'];
  const fromState = all.find(x => hrRoles.includes(String(x?.role || '').trim()) && String(x?.status || '').trim() !== '离职' && String(x?.status || '').trim() !== 'inactive')?.username;
  if (fromState) return String(fromState).trim();
  return '';
}

async function pickCashierUsername(state) {
  const users = Array.isArray(state?.users) ? state.users : [];
  const employees = Array.isArray(state?.employees) ? state.employees : [];
  // employees first – real users live there
  const all = employees.concat(users);
  const cashierRoles = ['cashier', 'custom_出纳'];
  const fromState = all.find(x => cashierRoles.includes(String(x?.role || '').trim()) && String(x?.status || '').trim() !== '离职' && String(x?.status || '').trim() !== 'inactive')?.username;
  if (fromState) return String(fromState).trim();

  try {
    const r = await pool.query("select username from users where role = 'cashier' and is_active = true order by created_at asc limit 1");
    const row = r.rows?.[0] || null;
    if (row?.username) return String(row.username).trim();
  } catch (e) {}

  return '';
}

function normalizeApprovalType(input) {
  const t = String(input || '').trim().toLowerCase();
  const allowed = ['onboarding', 'offboarding', 'leave', 'payment', 'reward_punishment', 'promotion', 'points'];
  if (!allowed.includes(t)) return '';
  return t;
}

function getApprovalFlowStepsFromState(state, type, applicantStore) {
  const st = state && typeof state === 'object' ? state : {};
  const flows = st.approvalFlows && typeof st.approvalFlows === 'object' ? st.approvalFlows : {};
  const cfg = flows[String(type || '').trim().toLowerCase()];
  if (!cfg || typeof cfg !== 'object') return [];
  const cfgStores = Array.isArray(cfg.stores) ? cfg.stores.map(x => String(x || '').trim()).filter(Boolean) : [];
  if (cfgStores.length > 0 && applicantStore) {
    const aStore = String(applicantStore).trim().toLowerCase();
    const match = cfgStores.some(s => s.toLowerCase() === aStore);
    if (!match) return [];
  }
  const steps = cfg.steps;
  return Array.isArray(steps) ? steps.map(x => String(x || '').trim()).filter(Boolean) : [];
}

function resolveApprovalFlowToken(token, ctx) {
  const t0 = String(token || '').trim();
  if (!t0) return '';
  const t = t0.toLowerCase();

  if (t === 'manager') return String(ctx?.managerUsername || '').trim();
  if (t === 'hq_manager') return String(ctx?.hqManagerUsername || '').trim();
  if (t === 'hr_manager') return String(ctx?.hrManagerUsername || '').trim();
  if (t === 'admin') return String(ctx?.adminUsername || '').trim();
  if (t === 'cashier') return String(ctx?.cashierUsername || '').trim();

  if (t.startsWith('username:')) {
    return String(t0.slice('username:'.length) || '').trim();
  }

  // Handle role: prefix (e.g. "role:custom_人事经理")
  if (t.startsWith('role:')) {
    const roleId = t0.slice('role:'.length).trim();
    if (roleId && ctx?.state) {
      const found = findUserByRole(ctx.state, roleId);
      if (found) return found;
    }
    return '';
  }

  // Try to resolve any other token as a role id (e.g. "custom_人事经理")
  if (ctx?.state) {
    const found = findUserByRole(ctx.state, t0);
    if (found) return found;
  }
  return '';
}

function findUserByRole(state, roleId) {
  const rid = String(roleId || '').trim();
  if (!rid) return '';
  const users = Array.isArray(state?.users) ? state.users : [];
  const employees = Array.isArray(state?.employees) ? state.employees : [];
  // employees first – real users live there
  const all = employees.concat(users);
  const match = all.find(x => {
    const r = String(x?.role || '').trim();
    const st = String(x?.status || '').trim();
    return r.toLowerCase() === rid.toLowerCase() && String(x?.username || '').trim() && st !== '离职' && st !== 'inactive';
  });
  return match ? String(match.username).trim() : '';
}

function buildApprovalAssigneesFromConfig(state, type, ctx) {
  const applicantStore = String(ctx?.applicantStore || '').trim();
  const steps = getApprovalFlowStepsFromState(state, type, applicantStore);
  if (!steps.length) return [];
  const assignees = steps
    .map(s => resolveApprovalFlowToken(s, ctx))
    .map(x => String(x || '').trim())
    .filter(Boolean);

  // de-dupe while keeping order
  const seen = new Set();
  const uniq = [];
  for (const a of assignees) {
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(a);
  }
  return uniq;
}

function getPaymentFlowForStore(state, store) {
  const st = state && typeof state === 'object' ? state : {};
  const map = st.paymentFlowByStore && typeof st.paymentFlowByStore === 'object' ? st.paymentFlowByStore : {};
  const key = String(store || '').trim();
  const cfg = key ? map[key] : null;
  const approvers = Array.isArray(cfg?.approvers) ? cfg.approvers.map(x => String(x || '').trim()).filter(Boolean) : [];
  const cashier = String(cfg?.cashier || '').trim();
  return { approvers, cashier };
}

function approvalTypeLabel(type) {
  const t = String(type || '').trim().toLowerCase();
  if (t === 'onboarding') return '入职';
  if (t === 'offboarding') return '离职';
  if (t === 'leave') return '休假';
  if (t === 'payment') return '请款';
  if (t === 'reward_punishment') return '奖惩';
  if (t === 'points') return '积分';
  if (t === 'promotion') return '晋升';
  if (t === 'monthly_confirm') return '月度考勤确认';
  return t || '审批';
}

function canApplyPointsByRole(roleInput) {
  const role = String(roleInput || '').trim();
  if (!role) return false;
  // 积分参与人：门店一线员工（前厅/后厨），店长和出品经理为审批角色不参与
  return role === 'store_employee' || role === 'employee';
}

function safeNumber(input) {
  const n = Number(input);
  return Number.isFinite(n) ? n : null;
}

function addStateNotification(state, notif) {
  const s = state && typeof state === 'object' ? state : {};
  const list = Array.isArray(s.notifications) ? s.notifications.slice() : [];
  list.push(notif);
  return { ...s, notifications: list };
}

function uniqUsernames(list) {
  const seen = new Set();
  const out = [];
  (list || []).forEach(u => {
    const v = String(u || '').trim();
    if (!v) return;
    const k = v.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(v);
  });
  return out;
}

function hrmsNowISO() {
  const now = new Date();
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  return `${y}-${m}-${d}T${h}:${mi}:${s}+08:00`;
}

function makeNotif(targetUser, title, message, extra) {
  return {
    id: 'NOTIF-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    type: String(extra?.type || 'notice'),
    targetUser: String(targetUser || '').trim(),
    title: String(title || '').trim() || '通知',
    message: String(message || '').trim(),
    createdAt: hrmsNowISO(),
    ...(extra && typeof extra === 'object' ? extra : {})
  };
}

app.post('/api/gm-mailbox', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: 'missing_content' });
  if (content.length < 5) return res.status(400).json({ error: 'content_too_short' });

  try {
    const state0 = (await getSharedState()) || {};
    const gm = (await pickHqManagerUsername(state0)) || (await pickAdminUsername(state0));
    const admin = await pickAdminUsername(state0);

    const item = {
      id: randomUUID(),
      createdAt: hrmsNowISO(),
      content,
      applicantUsername: username,
      anonymous: true
    };

    const mailbox = Array.isArray(state0.gmMailbox) ? state0.gmMailbox.slice() : [];
    mailbox.unshift(item);

    let state = { ...state0, gmMailbox: mailbox };
    const title = '总经理信箱（匿名）';
    const msg = content.length > 120 ? (content.slice(0, 120) + '...') : content;
    const recipients = uniqUsernames([gm, admin]);
    for (const u of recipients) {
      state = addStateNotification(state, makeNotif(u, title, msg, { type: 'gm_mailbox', mailboxId: item.id }));
    }

    await saveSharedState(state);
    return res.json({ ok: true, id: item.id });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

function canAccessDailyReports(role) {
  const r = String(role || '').trim();
  return r === 'admin' || r === 'hq_manager' || r === 'store_manager';
}

function canWriteDailyReports(role) {
  const r = String(role || '').trim();
  return r === 'admin';
}

function isAdmin(role) {
  return String(role || '').trim() === 'admin';
}

function isHq(role) {
  const r = String(role || '').trim();
  return r === 'hq_manager' || r === 'hr_manager';
}

function canAccessAnalyticsReports(role) {
  const r = String(role || '').trim();
  return r === 'admin' || r === 'hq_manager' || r === 'store_manager' || r === 'hr_manager' || r === 'store_production_manager';
}

function inDateRange(date, start, end) {
  const d = String(date || '').trim();
  if (!d) return false;
  const s = start ? String(start).trim() : '';
  const e = end ? String(end).trim() : '';
  if (s && d < s) return false;
  if (e && d > e) return false;
  return true;
}

app.get('/api/daily-reports', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!canAccessDailyReports(role)) return res.status(403).json({ error: 'forbidden' });

  const date = safeDateOnly(req.query?.date);
  const start = safeDateOnly(req.query?.start);
  const end = safeDateOnly(req.query?.end);
  const storeQ = String(req.query?.store || '').trim();
  const limit = Math.min(2000, Math.max(1, Number(req.query?.limit || 200)));

  try {
    const state0 = (await getSharedState()) || {};
    const me = stateFindUserRecord(state0, username) || {};
    const myStore = String(me?.store || '').trim();

    const store = role === 'store_manager' ? myStore : storeQ;
    let items = Array.isArray(state0.dailyReports) ? state0.dailyReports.slice() : [];
    if (store) items = items.filter(r => String(r?.store || '').trim() === String(store).trim());
    if (date) {
      items = items.filter(r => String(r?.date || '').trim() === String(date).trim());
    } else if (start || end) {
      items = items.filter(r => inDateRange(String(r?.date || '').trim(), start, end));
    }
    items.sort((a, b) => String(b?.date || '').localeCompare(String(a?.date || '')) || String(b?.updatedAt || b?.createdAt || '').localeCompare(String(a?.updatedAt || a?.createdAt || '')));
    items = items.slice(0, limit);
    return res.json({ items });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/daily-reports', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!canWriteDailyReports(role)) return res.status(403).json({ error: 'forbidden' });

  const date = safeDateOnly(req.body?.date);
  if (!date) return res.status(400).json({ error: 'missing_date' });

  try {
    const state0 = (await getSharedState()) || {};
    const me = stateFindUserRecord(state0, username) || {};
    const myStore = String(me?.store || '').trim();

    let store = String(req.body?.store || '').trim();
    if (role === 'store_manager') {
      store = myStore;
    }
    if (!store) return res.status(400).json({ error: 'missing_store' });

    const payload = req.body?.data && typeof req.body.data === 'object' ? req.body.data : {};
    const wantSubmit = !!req.body?.submitted;
    const now = hrmsNowISO();

    const list = Array.isArray(state0.dailyReports) ? state0.dailyReports.slice() : [];
    const idx = list.findIndex(r => String(r?.store || '').trim() === store && String(r?.date || '').trim() === date);

    let item;
    if (idx >= 0) {
      const prev = list[idx] || {};

      const alreadySubmitted = !!(prev?.submittedAt || prev?.submitted);
      if (alreadySubmitted && role === 'store_manager') {
        return res.status(403).json({ error: 'locked' });
      }

      const submittedAt = prev?.submittedAt || prev?.submitted_at || null;
      const submittedBy = prev?.submittedBy || prev?.submitted_by || null;
      const nextSubmittedAt = (wantSubmit && !submittedAt) ? now : submittedAt;
      const nextSubmittedBy = (wantSubmit && !submittedBy) ? username : submittedBy;

      item = {
        ...prev,
        store,
        date,
        data: payload,
        updatedAt: now,
        updatedBy: username
      };

      if (wantSubmit || submittedAt) {
        item.submittedAt = nextSubmittedAt;
        item.submittedBy = nextSubmittedBy;
      }
      list.splice(idx, 1);
      list.unshift(item);
    } else {
      item = {
        id: randomUUID(),
        store,
        date,
        data: payload,
        createdAt: now,
        createdBy: username,
        updatedAt: now,
        updatedBy: username
      };

      if (wantSubmit) {
        item.submittedAt = now;
        item.submittedBy = username;
      }
      list.unshift(item);
    }

    await saveSharedState({ ...state0, dailyReports: list });
    return res.json({ item });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.delete('/api/daily-reports', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!isAdmin(role)) return res.status(403).json({ error: 'forbidden' });

  const store = String(req.query?.store || '').trim();
  const date = safeDateOnly(req.query?.date);
  if (!store) return res.status(400).json({ error: 'missing_store' });
  if (!date) return res.status(400).json({ error: 'missing_date' });

  try {
    const state0 = (await getSharedState()) || {};
    const list = Array.isArray(state0.dailyReports) ? state0.dailyReports.slice() : [];
    const next = list.filter(r => !(String(r?.store || '').trim() === store && String(r?.date || '').trim() === date));
    await saveSharedState({ ...state0, dailyReports: next });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

function parseMonth(input) {
  const v = String(input || '').trim();
  if (!/^\d{4}-\d{2}$/.test(v)) return null;
  return v;
}

function clampNum(n, d = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : d;
}

function getStateUsers(state) {
  const users = Array.isArray(state?.users) ? state.users : [];
  const employees = Array.isArray(state?.employees) ? state.employees : [];
  return { users, employees };
}

function findUserSalary(state, username) {
  const u = String(username || '').trim();
  if (!u) return null;
  const { users, employees } = getStateUsers(state);
  const rec = users.find(x => String(x?.username || '').trim() === u) || employees.find(x => String(x?.username || '').trim() === u) || null;
  if (!rec) return null;
  const raw = (rec.salary !== undefined && rec.salary !== null && rec.salary !== '')
    ? rec.salary
    : ((rec.wage !== undefined && rec.wage !== null && rec.wage !== '')
      ? rec.wage
      : ((rec.baseSalary !== undefined && rec.baseSalary !== null && rec.baseSalary !== '')
        ? rec.baseSalary
        : ((rec.monthlySalary !== undefined && rec.monthlySalary !== null && rec.monthlySalary !== '')
          ? rec.monthlySalary
          : ((rec.pay !== undefined && rec.pay !== null && rec.pay !== '') ? rec.pay : null))));
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function buildAttendanceFromReports(items) {
  const out = [];
  const map = new Map();

  const add = (store, date, staffArr) => {
    const list = Array.isArray(staffArr) ? staffArr : [];
    for (const it of list) {
      const user = String(it?.user || it?.username || '').trim();
      if (!user) continue;
      const name = String(it?.name || '').trim();
      const days = clampNum(it?.days, 1);
      const key = `${store}||${date}||${user}`;
      const prev = map.get(key);
      if (prev) {
        prev.days = clampNum(prev.days, 0) + (Number.isFinite(days) ? days : 1);
      } else {
        const rec = { store, date, username: user, name, days: Number.isFinite(days) ? days : 1 };
        map.set(key, rec);
        out.push(rec);
      }
    }
  };

  (Array.isArray(items) ? items : []).forEach(r => {
    const store = String(r?.store || '').trim();
    const date = String(r?.date || '').trim();
    if (!store || !date) return;
    const data = r?.data && typeof r.data === 'object' ? r.data : {};
    add(store, date, data?.staff?.front);
    add(store, date, data?.staff?.kitchen);
  });

  out.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.store).localeCompare(String(b.store)) || String(a.username).localeCompare(String(b.username)));
  return out;
}

function pickMyStoreFromState(state, username) {
  const me = stateFindUserRecord(state, username) || {};
  const st = String(me?.store || '').trim();
  return st;
}

app.get('/api/reports/business', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!canAccessDailyReports(role)) return res.status(403).json({ error: 'forbidden' });

  const start = safeDateOnly(req.query?.start);
  const end = safeDateOnly(req.query?.end);
  if (!start || !end) return res.status(400).json({ error: 'missing_range' });
  const storeQ = String(req.query?.store || '').trim();

  try {
    const state0 = (await getSharedState()) || {};
    const myStore = pickMyStoreFromState(state0, username);
    const store = role === 'store_manager' ? myStore : storeQ;
    let items = Array.isArray(state0.dailyReports) ? state0.dailyReports.slice() : [];
    items = items.filter(r => inDateRange(String(r?.date || '').trim(), start, end));
    if (store) items = items.filter(r => String(r?.store || '').trim() === store);

    const emptyAgg = (st) => ({
      store: st, days: 0, budget: 0, gross: 0, actual: 0,
      discount: 0, discountDine: 0, discountDelivery: 0,
      rechargeCount: 0, rechargeAmount: 0,
      dineRevenue: 0, dineOrders: 0, dineTraffic: 0,
      segNoon: 0, segAfternoon: 0, segNight: 0,
      catWaterAmt: 0, catWaterQty: 0, catSoupAmt: 0, catSoupQty: 0,
      catRoastAmt: 0, catRoastQty: 0, catWokAmt: 0, catWokQty: 0,
      elemeOrders: 0, elemeRevenue: 0, elemeActual: 0, elemeTarget: 0,
      meituanOrders: 0, meituanRevenue: 0, meituanActual: 0, meituanTarget: 0,
      badDianping: 0, badMeituan: 0, badEleme: 0,
      laborTotal: 0
    });

    const byStore = new Map();
    items.forEach(r => {
      const st = String(r?.store || '').trim();
      if (!st) return;
      const data = r?.data && typeof r.data === 'object' ? r.data : {};
      const prev = byStore.get(st) || emptyAgg(st);
      prev.days += 1;
      prev.budget += clampNum(data?.budget, 0);
      prev.gross += clampNum(data?.gross, 0);
      prev.actual += clampNum(data?.actual, 0);
      prev.discount += clampNum(data?.discount?.total, 0);
      prev.discountDine += clampNum(data?.discount?.dine, 0);
      prev.discountDelivery += clampNum(data?.discount?.delivery, 0);
      prev.rechargeCount += clampNum(data?.recharge?.count, 0);
      prev.rechargeAmount += clampNum(data?.recharge?.amount, 0);
      prev.dineRevenue += clampNum(data?.dine?.revenue, 0);
      prev.dineOrders += clampNum(data?.dine?.orders, 0);
      prev.dineTraffic += clampNum(data?.dine?.traffic, 0);
      prev.segNoon += clampNum(data?.segments?.noon, 0);
      prev.segAfternoon += clampNum(data?.segments?.afternoon, 0);
      prev.segNight += clampNum(data?.segments?.night, 0);
      prev.catWaterAmt += clampNum(data?.categories?.water?.amt, 0);
      prev.catWaterQty += clampNum(data?.categories?.water?.qty, 0);
      prev.catSoupAmt += clampNum(data?.categories?.soup?.amt, 0);
      prev.catSoupQty += clampNum(data?.categories?.soup?.qty, 0);
      prev.catRoastAmt += clampNum(data?.categories?.roast?.amt, 0);
      prev.catRoastQty += clampNum(data?.categories?.roast?.qty, 0);
      prev.catWokAmt += clampNum(data?.categories?.wok?.amt, 0);
      prev.catWokQty += clampNum(data?.categories?.wok?.qty, 0);
      prev.elemeOrders += clampNum(data?.delivery?.eleme?.orders, 0);
      prev.elemeRevenue += clampNum(data?.delivery?.eleme?.revenue, 0);
      prev.elemeActual += clampNum(data?.delivery?.eleme?.actual, 0);
      prev.elemeTarget += clampNum(data?.delivery?.eleme?.targetRevenue, 0);
      prev.meituanOrders += clampNum(data?.delivery?.meituan?.orders, 0);
      prev.meituanRevenue += clampNum(data?.delivery?.meituan?.revenue, 0);
      prev.meituanActual += clampNum(data?.delivery?.meituan?.actual, 0);
      prev.meituanTarget += clampNum(data?.delivery?.meituan?.targetRevenue, 0);
      prev.badDianping += clampNum(data?.badReviews?.dianping, 0);
      prev.badMeituan += clampNum(data?.badReviews?.meituan, 0);
      prev.badEleme += clampNum(data?.badReviews?.eleme, 0);
      prev.laborTotal += clampNum(data?.laborTotal, 0);
      byStore.set(st, prev);
    });

    const rows = Array.from(byStore.values()).sort((a, b) => String(a.store).localeCompare(String(b.store), 'zh-Hans-CN'));
    const computeDerived = (x) => {
      x.budgetRate = x.budget > 0 ? (x.gross / x.budget) : 0;
      x.efficiency = x.laborTotal > 0 ? (x.gross / x.laborTotal) : 0;
      x.dineAvgTable = x.dineOrders > 0 ? (x.dineRevenue / x.dineOrders) : 0;
      x.dineAvgPerson = x.dineTraffic > 0 ? (x.dineRevenue / x.dineTraffic) : 0;
      x.discountRate = x.gross > 0 ? (x.discount / x.gross) : 0;
    };
    rows.forEach(computeDerived);

    const sumKeys = ['days','budget','gross','actual','discount','discountDine','discountDelivery','rechargeCount','rechargeAmount','dineRevenue','dineOrders','dineTraffic','segNoon','segAfternoon','segNight','catWaterAmt','catWaterQty','catSoupAmt','catSoupQty','catRoastAmt','catRoastQty','catWokAmt','catWokQty','elemeOrders','elemeRevenue','elemeActual','elemeTarget','meituanOrders','meituanRevenue','meituanActual','meituanTarget','badDianping','badMeituan','badEleme','laborTotal'];
    const total = emptyAgg('合计');
    rows.forEach(x => { sumKeys.forEach(k => { total[k] += (x[k] || 0); }); });
    computeDerived(total);

    // monthly targets from state
    let monthlyTargets = null;
    try {
      const stSettings = state0.settings && typeof state0.settings === 'object' ? state0.settings : {};
      const mt = Array.isArray(stSettings.monthlyTargets) ? stSettings.monthlyTargets : (Array.isArray(state0.monthlyTargets) ? state0.monthlyTargets : []);
      const ym = start.slice(0, 7);
      const tgt = mt.find(t => {
        const tMonth = String(t?.ym || t?.month || '').trim();
        const tStore = String(t?.store || '').trim();
        return tMonth === ym && (!store || tStore === store);
      });
      if (tgt) monthlyTargets = tgt.targets || null;
    } catch (e) {}

    // budget info from state
    let budgetInfo = null;
    try {
      const budgets = Array.isArray(state0.paymentBudgets) ? state0.paymentBudgets : [];
      const ym = start.slice(0, 7);
      const b = budgets.find(x => String(x?.month || '').trim() === ym && (!store || String(x?.store || '').trim() === store));
      if (b) budgetInfo = b;
    } catch (e) {}

    // budget execution: all categories for this store/month with actual usage
    let budgetExecution = [];
    try {
      const budgets = Array.isArray(state0.paymentBudgets) ? state0.paymentBudgets : [];
      const ym = start.slice(0, 7);
      const matched = budgets.filter(x => String(x?.month || '').trim() === ym && (!store || String(x?.store || '').trim() === store));
      if (matched.length > 0) {
        // query actual usage from approval_requests for approved+paid payments
        const usageParams = store ? [store, ym] : [ym];
        const storeClause = store ? "(payload->>'store') = $1 AND" : '';
        const monthParam = store ? '$2' : '$1';
        const usageResult = await pool.query(
          `SELECT (payload->>'category') as category,
                  COALESCE(SUM(NULLIF(payload->>'amount','')::numeric), 0)::float as used
           FROM approval_requests
           WHERE type = 'payment'
             AND status IN ('approved','paid')
             AND ${storeClause}
             substring(payload->>'date', 1, 7) = ${monthParam}
           GROUP BY (payload->>'category')`,
          usageParams
        );
        const usageMap = {};
        for (const row of (usageResult.rows || [])) {
          usageMap[String(row.category || '').trim()] = Number(row.used || 0);
        }
        budgetExecution = matched.map(b => {
          const cat = String(b.category || '').trim();
          const budgetAmt = Number(b.amount || 0);
          const used = Number(usageMap[cat] || 0);
          const remaining = budgetAmt - used;
          const rate = budgetAmt > 0 ? (used / budgetAmt) : 0;
          return { category: cat, budget: budgetAmt, used, remaining, rate };
        });
      }
    } catch (e) {}

    return res.json({ start, end, store: store || '', rows, total, monthlyTargets, budgetInfo, budgetExecution });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

// ── Turnover Analysis Report ──
app.get('/api/reports/turnover', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!canAccessAnalyticsReports(role)) return res.status(403).json({ error: 'forbidden' });

  const month = String(req.query?.month || '').trim(); // e.g. "2026-02"
  const storeQ = String(req.query?.store || '').trim();
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'missing_month' });

  try {
    const state0 = (await getSharedState()) || {};
    const myStore = pickMyStoreFromState(state0, username);
    const store = role === 'store_manager' ? myStore : storeQ;

    const allEmployees = Array.isArray(state0.employees) ? state0.employees : [];
    const [yr, mo] = month.split('-').map(Number);
    const monthStart = new Date(yr, mo - 1, 1);
    const monthEnd = new Date(yr, mo, 0); // last day of month

    // Filter employees by store if specified
    const storeEmps = store
      ? allEmployees.filter(e => String(e?.store || '').trim() === store)
      : allEmployees;

    // ── Identify departed employees this month ──
    // An employee is "departed this month" if:
    //   status === '离职' AND (offboardingDate or resignedAt) falls within the month
    const departedThisMonth = storeEmps.filter(e => {
      if (String(e?.status || '').trim() !== '离职') return false;
      const depDate = String(e?.offboardingDate || e?.resignedAt || '').trim();
      if (!depDate) return false;
      return depDate >= month + '-01' && depDate <= month + '-31';
    });

    // Total active employees at start of month (active + those who departed this month)
    const activeOrDepartedThisMonth = storeEmps.filter(e => {
      const st = String(e?.status || '').trim();
      if (st === 'active') return true;
      // departed this month counts as was-active
      if (st === '离职') {
        const depDate = String(e?.offboardingDate || e?.resignedAt || '').trim();
        if (depDate && depDate >= month + '-01') return true;
      }
      return false;
    });
    const totalHeadcount = activeOrDepartedThisMonth.length;
    const totalDeparted = departedThisMonth.length;
    const overallTurnoverRate = totalHeadcount > 0 ? totalDeparted / totalHeadcount : 0;

    // ── A. Critical Talent Turnover ──
    // Core talent: level >= 3, or role in [store_manager, hq_manager, hr_manager], or position contains 经理/主管/店长
    const isCoreTalent = (e) => {
      const level = Number(e?.level || 0);
      const r = String(e?.role || '').trim();
      const pos = String(e?.position || '').trim();
      if (level >= 3) return true;
      if (['store_manager', 'hq_manager', 'hr_manager'].includes(r)) return true;
      if (/经理|主管|店长|总监|主任/.test(pos)) return true;
      return false;
    };
    const coreTalentAll = activeOrDepartedThisMonth.filter(isCoreTalent);
    const coreTalentDeparted = departedThisMonth.filter(isCoreTalent);
    const criticalTurnoverRate = coreTalentAll.length > 0 ? coreTalentDeparted.length / coreTalentAll.length : 0;

    // ── B. New Hire Retention ──
    // New hire: joinDate within 3 months before end of report month
    const threeMonthsAgo = new Date(yr, mo - 4, 1); // 3 months before month start
    const threeMonthsAgoStr = `${threeMonthsAgo.getFullYear()}-${String(threeMonthsAgo.getMonth() + 1).padStart(2, '0')}-01`;
    const isNewHire = (e) => {
      const jd = String(e?.joinDate || e?.createdAt || '').trim().slice(0, 10);
      if (!jd) return false;
      return jd >= threeMonthsAgoStr && jd <= month + '-31';
    };
    const newHireAll = activeOrDepartedThisMonth.filter(isNewHire);
    const newHireDeparted = departedThisMonth.filter(isNewHire);
    const newHireTurnoverRate = newHireAll.length > 0 ? newHireDeparted.length / newHireAll.length : 0;
    const newHireRetentionRate = 1 - newHireTurnoverRate;

    // ── C. Voluntary vs Involuntary ──
    // Check offboarding approval payloads for departure reason
    let voluntaryCount = 0;
    let involuntaryCount = 0;
    const departedDetails = [];

    // Fetch offboarding approvals for this month
    try {
      const offboardingResult = await pool.query(
        `SELECT id, applicant_username, payload, status, created_at, updated_at
         FROM approval_requests
         WHERE type = 'offboarding'
           AND status IN ('approved', 'pending')
           AND substring(COALESCE(
             payload->>'resignDate',
             payload->>'date',
             payload->>'resignationDate',
             created_at::text
           ), 1, 7) = $1
         ORDER BY created_at DESC`,
        [month]
      );
      const offRows = offboardingResult.rows || [];
      for (const ob of offRows) {
        const payload = typeof ob.payload === 'string' ? JSON.parse(ob.payload) : (ob.payload || {});
        const reason = String(payload?.reason || '').trim();
        const detail = String(payload?.detail || '').trim();
        const depType = String(payload?.departureType || '').trim();
        const empUsername = String(ob.applicant_username || '').trim();
        const empRec = storeEmps.find(e => String(e?.username || '').toLowerCase() === empUsername.toLowerCase());
        if (store && empRec && String(empRec?.store || '').trim() !== store) continue;

        // Determine voluntary vs involuntary
        let isVoluntary = true; // default: voluntary (resignation)
        if (depType === 'involuntary' || depType === '被动') {
          isVoluntary = false;
        } else if (/劝退|辞退|裁员|开除|解雇|淘汰/.test(reason) || /劝退|辞退|裁员|开除|解雇|淘汰/.test(detail)) {
          isVoluntary = false;
        }

        if (isVoluntary) voluntaryCount++;
        else involuntaryCount++;

        departedDetails.push({
          username: empUsername,
          name: String(empRec?.name || payload?.name || empUsername).trim(),
          store: String(empRec?.store || payload?.store || '').trim(),
          position: String(empRec?.position || '').trim(),
          level: String(empRec?.level || '').trim(),
          joinDate: String(empRec?.joinDate || empRec?.createdAt || '').trim().slice(0, 10),
          departureDate: String(payload?.resignDate || payload?.date || '').trim(),
          reason: reason,
          departureType: isVoluntary ? 'voluntary' : 'involuntary',
          isCoreTalent: empRec ? isCoreTalent(empRec) : false,
          isNewHire: empRec ? isNewHire(empRec) : false
        });
      }
    } catch (e) {
      // If no approval data, fall back to counting all as voluntary
      voluntaryCount = totalDeparted;
    }

    // If no approval records found but we have departed employees, default all to voluntary
    if (voluntaryCount === 0 && involuntaryCount === 0 && totalDeparted > 0) {
      voluntaryCount = totalDeparted;
    }

    const totalDepartedForRatio = voluntaryCount + involuntaryCount;
    const voluntaryRate = totalDepartedForRatio > 0 ? voluntaryCount / totalDepartedForRatio : 0;
    const involuntaryRate = totalDepartedForRatio > 0 ? involuntaryCount / totalDepartedForRatio : 0;

    // ── Store breakdown ──
    const stores = [...new Set(storeEmps.map(e => String(e?.store || '').trim()).filter(Boolean))];
    const storeBreakdown = stores.map(s => {
      const sEmps = activeOrDepartedThisMonth.filter(e => String(e?.store || '').trim() === s);
      const sDep = departedThisMonth.filter(e => String(e?.store || '').trim() === s);
      const sCore = sEmps.filter(isCoreTalent);
      const sCoreDep = sDep.filter(isCoreTalent);
      const sNew = sEmps.filter(isNewHire);
      const sNewDep = sDep.filter(isNewHire);
      return {
        store: s,
        headcount: sEmps.length,
        departed: sDep.length,
        turnoverRate: sEmps.length > 0 ? sDep.length / sEmps.length : 0,
        coreTalentTotal: sCore.length,
        coreTalentDeparted: sCoreDep.length,
        criticalRate: sCore.length > 0 ? sCoreDep.length / sCore.length : 0,
        newHireTotal: sNew.length,
        newHireDeparted: sNewDep.length,
        newHireRetention: sNew.length > 0 ? 1 - (sNewDep.length / sNew.length) : 1
      };
    });

    return res.json({
      month,
      store: store || '',
      totalHeadcount,
      totalDeparted,
      overallTurnoverRate,
      criticalTalent: {
        total: coreTalentAll.length,
        departed: coreTalentDeparted.length,
        rate: criticalTurnoverRate
      },
      newHire: {
        total: newHireAll.length,
        departed: newHireDeparted.length,
        turnoverRate: newHireTurnoverRate,
        retentionRate: newHireRetentionRate
      },
      voluntaryInvoluntary: {
        voluntary: voluntaryCount,
        involuntary: involuntaryCount,
        voluntaryRate,
        involuntaryRate
      },
      departedDetails,
      storeBreakdown
    });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/reports/attendance', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!canAccessAnalyticsReports(role)) return res.status(403).json({ error: 'forbidden' });

  const start = safeDateOnly(req.query?.start);
  const end = safeDateOnly(req.query?.end);
  if (!start || !end) return res.status(400).json({ error: 'missing_range' });
  const storeQ = String(req.query?.store || '').trim();

  try {
    const state0 = (await getSharedState()) || {};
    const myStore = pickMyStoreFromState(state0, username);
    const store = role === 'store_manager' ? myStore : storeQ;
    let items = Array.isArray(state0.dailyReports) ? state0.dailyReports.slice() : [];
    items = items.filter(r => inDateRange(String(r?.date || '').trim(), start, end));
    if (store) items = items.filter(r => String(r?.store || '').trim() === store);

    const rows = buildAttendanceFromReports(items);

    // Also fetch detailed checkin records from DB
    let checkinDetails = [];
    try {
      let conditions = [`check_time >= $1::date`, `check_time < ($2::date + interval '1 day')`];
      let params = [start, end];
      let idx = 3;
      if (store) { conditions.push(`c.store = $${idx}`); params.push(store); idx++; }
      const where = 'where ' + conditions.join(' and ');
      const sql = `select c.* from checkin_records c ${where} order by c.check_time desc limit 5000`;
      const cr = await pool.query(sql, params);
      checkinDetails = (cr.rows || []).map(r => {
        const emp = (Array.isArray(state0.employees) ? state0.employees : []).find(e => String(e?.username || '').toLowerCase() === String(r.username || '').toLowerCase());
        const usr = (Array.isArray(state0.users) ? state0.users : []).find(e => String(e?.username || '').toLowerCase() === String(r.username || '').toLowerCase());
        r.display_name = emp?.name || usr?.name || r.username;
        return r;
      });
    } catch (e) {}

    return res.json({ start, end, store: store || '', rows, checkinDetails });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/reports/payroll', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!canAccessAnalyticsReports(role)) return res.status(403).json({ error: 'forbidden' });

  const month = parseMonth(req.query?.month);
  if (!month) return res.status(400).json({ error: 'missing_month' });
  const storeQ = String(req.query?.store || '').trim();

  try {
    const state0 = (await getSharedState()) || {};
    const myStore = pickMyStoreFromState(state0, username);
    const store = role === 'store_manager' ? myStore : storeQ;

    const start = `${month}-01`;
    const end = `${month}-31`;
    let items = Array.isArray(state0.dailyReports) ? state0.dailyReports.slice() : [];
    items = items.filter(r => inDateRange(String(r?.date || '').trim(), start, end));
    if (store) items = items.filter(r => String(r?.store || '').trim() === store);

    const attendanceRows = buildAttendanceFromReports(items);
    const pointStoreByUser = new Map();
    const pointSubsidyByUserStore = new Map();
    const pointRecords = Array.isArray(state0?.pointRecords) ? state0.pointRecords : [];
    pointRecords.forEach(r => {
      const recMonth = String(r?.approvedAt || r?.createdAt || '').slice(0, 7);
      if (recMonth !== month) return;
      const u = String(r?.username || '').trim().toLowerCase();
      const st = String(r?.store || '').trim();
      if (!u) return;
      if (st && !pointStoreByUser.has(u)) pointStoreByUser.set(u, st);
      const amountFromRecord = safeNumber(r?.amount);
      const points = safeNumber(r?.points) || 0;
      const subsidyAmount = amountFromRecord != null ? amountFromRecord : Number((points * 0.5).toFixed(2));
      if (!subsidyAmount) return;
      const subsidyKey = `${st || 'ALL'}||${u}`;
      const prevSubsidy = safeNumber(pointSubsidyByUserStore.get(subsidyKey)) || 0;
      pointSubsidyByUserStore.set(subsidyKey, Number((prevSubsidy + subsidyAmount).toFixed(2)));
    });
    const knownUsers = new Set();
    const allPeople = []
      .concat(Array.isArray(state0?.employees) ? state0.employees : [])
      .concat(Array.isArray(state0?.users) ? state0.users : []);
    allPeople.forEach(p => {
      const u = String(p?.username || '').trim().toLowerCase();
      if (u && !isLegacyTestUsername(u)) knownUsers.add(u);
    });
    const [yearNum, monthNum] = month.split('-').map(Number);
    const monthDays = new Date(yearNum, monthNum, 0).getDate();
    // Business rule: daily rate uses salary / (days in month - 4 fixed weekly offs)
    const workDaysPerMonth = Math.max(1, monthDays - 4);

    const sumMap = new Map();
    for (const r of attendanceRows) {
      const st = String(r?.store || '').trim();
      const u = String(r?.username || '').trim();
      if (!st || !u) continue;
      if (!knownUsers.has(u.toLowerCase())) continue;
      const key = `${st}||${u}`;
      const prev = sumMap.get(key) || { store: st, username: u, name: String(r?.name || '').trim(), days: 0 };
      prev.days += clampNum(r?.days, 0);
      if (!prev.name) prev.name = String(r?.name || '').trim();
      sumMap.set(key, prev);
    }

    const adjustmentMap = new Map();
    const adjRows = Array.isArray(state0?.salaryAdjustments) ? state0.salaryAdjustments : [];
    for (const a of adjRows) {
      if (!a || typeof a !== 'object') continue;
      const st = String(a?.status || '').trim().toLowerCase();
      if (st && st !== 'approved') continue;
      const target = String(a?.targetUsername || '').trim();
      if (!target) continue;
      if (isLegacyTestUsername(target)) continue;
      const ym = String(a?.createdAt || a?.effectiveAt || '').slice(0, 7);
      if (ym !== month) continue;
      let signed = safeNumber(a?.signedAmount);
      if (signed == null) {
        const raw = Math.abs(safeNumber(a?.amount) || 0);
        const tp = String(a?.type || a?.rpType || '').trim().toLowerCase();
        const isPunish = tp.includes('惩罚') || tp.includes('punish');
        signed = isPunish ? -raw : raw;
      }
      const key = target.toLowerCase();
      adjustmentMap.set(key, (adjustmentMap.get(key) || 0) + (signed || 0));

      // Ensure people with salary adjustments still appear in payroll rows even with zero attendance
      const rec = stateFindUserRecord(state0, target) || {};
      const recStore = String(rec?.store || '').trim();
      if (!store || recStore === store) {
        const attKey = `${recStore}||${target}`;
        if (!sumMap.has(attKey)) {
          sumMap.set(attKey, {
            store: recStore,
            username: target,
            name: String(rec?.name || target).trim(),
            days: 0
          });
        }
      }
    }

    const payrollAdjMap = state0?.payrollAdjustments && typeof state0.payrollAdjustments === 'object' ? state0.payrollAdjustments : {};

    // Ensure people with points/manual subsidy still appear even when attendance is 0
    Object.entries(payrollAdjMap).forEach(([k, v]) => {
      const key = String(k || '').trim();
      const m = key.match(/^(\d{4}-\d{2})\|\|(.+)\|\|(.+)$/);
      if (!m) return;
      const keyMonth = String(m[1] || '').trim();
      const keyStore = String(m[2] || '').trim();
      const keyUser = String(m[3] || '').trim();
      if (keyMonth !== month || !keyUser) return;
      if (isLegacyTestUsername(keyUser)) return;
      const subsidy = safeNumber(v?.subsidy ?? v?.amount) || 0;
      if (!subsidy) return;
      const rec = stateFindUserRecord(state0, keyUser) || {};
      const recStore = String(keyStore && keyStore !== 'ALL' ? keyStore : (rec?.store || pointStoreByUser.get(keyUser.toLowerCase()) || '')).trim();
      if (store && recStore !== store) return;
      const attKey = `${recStore}||${keyUser}`;
      if (!sumMap.has(attKey)) {
        sumMap.set(attKey, {
          store: recStore,
          username: keyUser,
          name: String(rec?.name || keyUser).trim(),
          days: 0
        });
      }
    });

    // Ensure zero-attendance employees are still listed when they have salary/adjustments/points
    allPeople.forEach(p => {
      const rowUser = String(p?.username || '').trim();
      const rowUserLower = rowUser.toLowerCase();
      if (!rowUser || !knownUsers.has(rowUserLower)) return;

      const rowStore = String(p?.store || pointStoreByUser.get(rowUserLower) || '').trim();
      if (store && rowStore !== store) return;

      const salary = findUserSalary(state0, rowUser);
      const hasSalary = salary != null;
      const hasAdjustment = adjustmentMap.has(rowUserLower);
      const pointSubsidyByStore = safeNumber(pointSubsidyByUserStore.get(`${rowStore || 'ALL'}||${rowUserLower}`)) || 0;
      const pointSubsidyAllStore = rowStore ? (safeNumber(pointSubsidyByUserStore.get(`ALL||${rowUserLower}`)) || 0) : 0;
      const hasPointSubsidy = (pointSubsidyByStore + pointSubsidyAllStore) > 0;
      if (!hasSalary && !hasAdjustment && !hasPointSubsidy) return;

      const attKey = `${rowStore}||${rowUser}`;
      if (!sumMap.has(attKey)) {
        sumMap.set(attKey, {
          store: rowStore,
          username: rowUser,
          name: String(p?.name || rowUser).trim(),
          days: 0
        });
      }
    });

    const rows = Array.from(sumMap.values()).map(x => {
      const monthlySalary = findUserSalary(state0, x.username);
      const dailyRate = monthlySalary != null ? (monthlySalary / workDaysPerMonth) : null;
      const baseAmount = dailyRate != null ? (dailyRate * clampNum(x.days, 0)) : null;
      const rewardPunishmentAdj = adjustmentMap.get(String(x.username || '').toLowerCase()) || 0;
      const rowStore = String(x.store || '').trim();
      const rowUser = String(x.username || '').trim().toLowerCase();
      const fallbackStore = String(pointStoreByUser.get(rowUser) || '').trim();
      const effectiveStore = rowStore || fallbackStore;
      const adjKey = `${month}||${effectiveStore || 'ALL'}||${rowUser}`;
      const subsidyByStore = safeNumber(payrollAdjMap?.[adjKey]?.subsidy ?? payrollAdjMap?.[adjKey]?.amount) || 0;
      const subsidyAllStore = effectiveStore
        ? (safeNumber(payrollAdjMap?.[`${month}||ALL||${rowUser}`]?.subsidy ?? payrollAdjMap?.[`${month}||ALL||${rowUser}`]?.amount) || 0)
        : 0;
      const subsidyFromPayrollAdjustments = subsidyByStore + subsidyAllStore;
      const pointSubsidyByStore = safeNumber(pointSubsidyByUserStore.get(`${effectiveStore || 'ALL'}||${rowUser}`)) || 0;
      const pointSubsidyAllStore = effectiveStore ? (safeNumber(pointSubsidyByUserStore.get(`ALL||${rowUser}`)) || 0) : 0;
      const subsidyFromPointRecords = pointSubsidyByStore + pointSubsidyAllStore;
      const subsidy = Number(Math.max(subsidyFromPayrollAdjustments, subsidyFromPointRecords).toFixed(2));
      const amount = baseAmount != null ? (baseAmount + rewardPunishmentAdj + subsidy) : ((rewardPunishmentAdj || 0) + subsidy || null);
      return {
        store: effectiveStore,
        username: x.username,
        name: x.name,
        attendanceDays: x.days,
        monthlySalary,
        dailyRate,
        baseAmount,
        rewardPunishmentAdj,
        subsidy,
        amount
      };
    });

    rows.sort((a, b) => String(a.store).localeCompare(String(b.store), 'zh-Hans-CN') || String(a.name || a.username).localeCompare(String(b.name || b.username), 'zh-Hans-CN'));

    const auditKey = `${month}||${store || 'ALL'}`;
    const auditMap = state0?.payrollAudits && typeof state0.payrollAudits === 'object' ? state0.payrollAudits : {};
    const audit = auditMap[auditKey] || null;

    const totalAmount = rows.reduce((s, x) => s + clampNum(x.amount, 0), 0);
    return res.json({ month, store: store || '', monthDays, workDaysPerMonth, audit, rows, totalAmount });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/reports/payroll/audit', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!(isAdmin(role) || isHq(role))) return res.status(403).json({ error: 'forbidden' });

  const month = parseMonth(req.body?.month);
  if (!month) return res.status(400).json({ error: 'missing_month' });
  const store = String(req.body?.store || '').trim();
  const audited = !!req.body?.audited;

  try {
    const state0 = (await getSharedState()) || {};
    const auditKey = `${month}||${store || 'ALL'}`;
    const auditMap = state0?.payrollAudits && typeof state0.payrollAudits === 'object' ? { ...state0.payrollAudits } : {};
    auditMap[auditKey] = {
      month,
      store: store || '',
      audited,
      auditedBy: username,
      auditedAt: hrmsNowISO()
    };
    await saveSharedState({ ...state0, payrollAudits: auditMap });
    return res.json({ ok: true, audit: auditMap[auditKey] });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/reports/payroll/adjustment', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!(isAdmin(role) || role === 'hr_manager')) return res.status(403).json({ error: 'forbidden' });

  const month = parseMonth(req.body?.month);
  if (!month) return res.status(400).json({ error: 'missing_month' });
  const store = String(req.body?.store || '').trim();
  const targetUsername = String(req.body?.username || '').trim();
  if (!targetUsername) return res.status(400).json({ error: 'missing_username' });

  const subsidy = safeNumber(req.body?.subsidy);
  if (subsidy == null) return res.status(400).json({ error: 'invalid_subsidy' });

  try {
    const state0 = (await getSharedState()) || {};
    const payrollAdjustments = state0?.payrollAdjustments && typeof state0.payrollAdjustments === 'object' ? { ...state0.payrollAdjustments } : {};
    const key = `${month}||${store || 'ALL'}||${targetUsername.toLowerCase()}`;
    payrollAdjustments[key] = {
      month,
      store: store || '',
      username: targetUsername,
      subsidy,
      updatedBy: username,
      updatedAt: hrmsNowISO()
    };
    await saveSharedState({ ...state0, payrollAdjustments });
    return res.json({ ok: true, item: payrollAdjustments[key] });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/points/rules', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  const storeQ = String(req.query?.store || '').trim();
  try {
    const state0 = (await getSharedState()) || {};
    const myStore = pickMyStoreFromState(state0, username);
    const store = storeQ || myStore;
    const items = (Array.isArray(state0.pointRules) ? state0.pointRules : [])
      .filter(x => {
        if (!x || typeof x !== 'object') return false;
        const st = String(x?.store || '').trim();
        return !store || st === store;
      })
      .sort((a, b) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')));
    return res.json({ store: store || '', items });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/points/rules', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!(role === 'admin' || role === 'hr_manager')) return res.status(403).json({ error: 'forbidden' });

  const store = String(req.body?.store || '').trim();
  const itemName = String(req.body?.itemName || '').trim();
  const points = safeNumber(req.body?.points);
  const enabled = req.body?.enabled !== false;
  if (!store) return res.status(400).json({ error: 'missing_store' });
  if (!itemName) return res.status(400).json({ error: 'missing_item_name' });
  if (points == null || points <= 0) return res.status(400).json({ error: 'invalid_points' });

  try {
    const state0 = (await getSharedState()) || {};
    const list = Array.isArray(state0.pointRules) ? state0.pointRules.slice() : [];
    const item = {
      id: randomUUID(),
      store,
      itemName,
      points,
      enabled,
      updatedBy: username,
      updatedAt: hrmsNowISO()
    };
    list.unshift(item);
    await saveSharedState({ ...state0, pointRules: list });
    return res.json({ ok: true, item });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.put('/api/points/rules/:id', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  const id = String(req.params?.id || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (!(role === 'admin' || role === 'hr_manager')) return res.status(403).json({ error: 'forbidden' });
  if (!id) return res.status(400).json({ error: 'missing_id' });

  const nextStore = req.body?.store == null ? null : String(req.body?.store || '').trim();
  const nextItemName = req.body?.itemName == null ? null : String(req.body?.itemName || '').trim();
  const nextPoints = req.body?.points == null ? null : safeNumber(req.body?.points);
  const nextEnabled = req.body?.enabled;

  try {
    const state0 = (await getSharedState()) || {};
    const list = Array.isArray(state0.pointRules) ? state0.pointRules.slice() : [];
    const idx = list.findIndex(x => String(x?.id || '').trim() === id);
    if (idx < 0) return res.status(404).json({ error: 'not_found' });
    const merged = {
      ...list[idx],
      ...(nextStore != null ? { store: nextStore } : {}),
      ...(nextItemName != null ? { itemName: nextItemName } : {}),
      ...(nextPoints != null ? { points: nextPoints } : {}),
      ...(typeof nextEnabled === 'boolean' ? { enabled: nextEnabled } : {}),
      updatedBy: username,
      updatedAt: hrmsNowISO()
    };
    if (!String(merged?.store || '').trim()) return res.status(400).json({ error: 'missing_store' });
    if (!String(merged?.itemName || '').trim()) return res.status(400).json({ error: 'missing_item_name' });
    if (safeNumber(merged?.points) == null || safeNumber(merged?.points) <= 0) return res.status(400).json({ error: 'invalid_points' });
    list[idx] = merged;
    await saveSharedState({ ...state0, pointRules: list });
    return res.json({ ok: true, item: merged });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/points/my', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  try {
    const state0 = (await getSharedState()) || {};
    const list = Array.isArray(state0.pointRecords) ? state0.pointRecords : [];
    const mine = list.filter(x => String(x?.username || '').trim().toLowerCase() === username.toLowerCase());
    const month = new Date().toISOString().slice(0, 7);
    const monthPoints = mine
      .filter(x => String(x?.approvedAt || x?.createdAt || '').slice(0, 7) === month)
      .reduce((s, x) => s + (safeNumber(x?.points) || 0), 0);
    const monthAmount = Number((monthPoints * 0.5).toFixed(2));
    return res.json({ month, monthPoints, monthAmount, items: mine });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

function safeDateOnly(input) {
  const v = String(input || '').trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return v;
}

function safeMonthOnly(input) {
  const v = String(input || '').trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}$/.test(v)) return null;
  return v;
}

function safeUuid(input) {
  const v = String(input || '').trim();
  if (!v) return '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return '';
  return v;
}

async function ensureExamResultsTable() {
  try {
    await pool.query('create extension if not exists pgcrypto');
    await pool.query(
      `create table if not exists exam_results (
        id uuid primary key default gen_random_uuid(),
        assignment_id uuid,
        user_key varchar(100) not null,
        created_at timestamp default current_timestamp,
        started_at timestamp,
        submitted_at timestamp,
        time_used_seconds integer,
        auto_submitted boolean default false,
        set_index integer,
        total integer,
        correct integer,
        score integer,
        answers jsonb
      )`
    );

    // In case an older schema exists, backfill missing columns.
    await pool.query(`alter table exam_results add column if not exists assignment_id uuid`);
    await pool.query(`alter table exam_results add column if not exists user_key varchar(100)`);
    await pool.query(`alter table exam_results add column if not exists created_at timestamp default current_timestamp`);
    await pool.query(`alter table exam_results add column if not exists started_at timestamp`);
    await pool.query(`alter table exam_results add column if not exists submitted_at timestamp`);
    await pool.query(`alter table exam_results add column if not exists time_used_seconds integer`);
    await pool.query(`alter table exam_results add column if not exists auto_submitted boolean default false`);
    await pool.query(`alter table exam_results add column if not exists set_index integer`);
    await pool.query(`alter table exam_results add column if not exists total integer`);
    await pool.query(`alter table exam_results add column if not exists correct integer`);
    await pool.query(`alter table exam_results add column if not exists score integer`);
    await pool.query(`alter table exam_results add column if not exists answers jsonb`);

    const hasUserKey = await hasColumn('exam_results', 'user_key');
    const hasCreatedAt = await hasColumn('exam_results', 'created_at');
    const hasAssignmentId = await hasColumn('exam_results', 'assignment_id');

    if (hasUserKey && hasCreatedAt) {
      await pool.query(
        `create index if not exists idx_exam_results_user_key_created_at
         on exam_results (user_key, created_at desc)`
      );
    }
    if (hasAssignmentId) {
      await pool.query(
        `create index if not exists idx_exam_results_assignment_id
         on exam_results (assignment_id)`
      );
    }
  } catch (e) {
    console.error('ensureExamResultsTable failed:', e);
  }
}

function getOssClient() {
  if (!OSS_REGION || !OSS_BUCKET || !OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET) return null;
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: Math.max(4, OSS_PARALLEL * 4),
    maxFreeSockets: Math.max(2, OSS_PARALLEL * 2),
    timeout: Math.max(10000, OSS_TIMEOUT_MS)
  });
  return new OSS({
    region: OSS_REGION,
    bucket: OSS_BUCKET,
    accessKeyId: OSS_ACCESS_KEY_ID,
    accessKeySecret: OSS_ACCESS_KEY_SECRET,
    secure: true,
    timeout: Math.max(10000, OSS_TIMEOUT_MS),
    agent
  });
}

function getCosClient() {
  if (!COS_SECRET_ID || !COS_SECRET_KEY || !COS_BUCKET || !COS_REGION) return null;
  return new COS({
    SecretId: COS_SECRET_ID,
    SecretKey: COS_SECRET_KEY
  });
}

function buildCosPublicUrl(objectKey) {
  const key = String(objectKey || '').replace(/^\/+/, '');
  if (!key) return '';
  const base = String(COS_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (base) return `${base}/${key}`;
  if (!COS_BUCKET || !COS_REGION) return '';
  return `https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/${key}`;
}

function buildOssPublicUrl(objectKey) {
  const key = String(objectKey || '').replace(/^\/+/, '');
  if (!key) return '';
  const base = String(OSS_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (base) return `${base}/${key}`;
  if (!OSS_BUCKET || !OSS_REGION) return '';
  return `https://${OSS_BUCKET}.${OSS_REGION}.aliyuncs.com/${key}`;
}

function encodeRFC5987ValueChars(str) {
  return encodeURIComponent(String(str || ''))
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A')
    .replace(/%(7C|60|5E)/g, (m) => m.toLowerCase());
}

function buildInlineContentDisposition(filename) {
  const name = String(filename || '').trim() || 'file';
  const encoded = encodeRFC5987ValueChars(name);
  return `inline; filename*=UTF-8''${encoded}`;
}

function inferContentType({ declaredType, originalName, mimeType }) {
  const t = String(declaredType || '').trim().toLowerCase();
  const orig = String(originalName || '').trim();
  const ext = path.extname(orig).toLowerCase();
  const mt = String(mimeType || '').trim().toLowerCase();

  if (mt && mt !== 'application/octet-stream') return mt;

  if (t === 'pdf' || ext === '.pdf') return 'application/pdf';
  if (t === 'video' || ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (t === 'img' || ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';

  if (ext === '.txt') return 'text/plain; charset=utf-8';
  if (ext === '.doc') return 'application/msword';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  return 'application/octet-stream';
}

function requireEnv() {
  const missing = [];
  if (!DATABASE_URL) missing.push('DATABASE_URL');
  if (!JWT_SECRET) missing.push('JWT_SECRET');
  return missing;
}

async function authRequired(req, res, next) {
  const hdr = String(req.headers.authorization || '');
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET || 'local_dev_secret');
    req.user = payload;

    // Single-device login: validate session nonce
    const nonce = String(payload.sn || '').trim();
    const uname = String(payload.username || '').trim();
    if (nonce && uname) {
      try {
        const r = await pool.query('select session_nonce from user_sessions where lower(username) = lower($1) limit 1', [uname]);
        const stored = String(r.rows?.[0]?.session_nonce || '').trim();
        if (stored && stored !== nonce) {
          return res.status(401).json({ error: 'session_replaced', message: '您的账号已在其他设备登录，当前会话已失效' });
        }
      } catch (e) {
        // DB error: allow through to avoid blocking all requests
      }
    }

    next();
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

function authRequiredOrQueryToken(req, res, next) {
  const hdr = String(req.headers.authorization || '');
  let token = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  if (!token) {
    try {
      token = String(req.query?.token || req.query?.access_token || '').trim();
    } catch (e) {
      token = '';
    }
  }
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET || 'local_dev_secret');
    req.user = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

function normalizeRoleForJwt(input) {
  const v = String(input || '').trim();
  if (!v) return 'store_employee';
  const allowed = ['admin', 'hq_manager', 'store_manager', 'store_employee', 'cashier', 'hr_manager', 'store_production_manager'];
  if (allowed.includes(v)) return v;
  // Map known Chinese/custom role names to standard codes BEFORE preserving custom_ prefix
  const map = {
    '管理员': 'admin',
    '系统管理员': 'admin',
    '总部管理层': 'hq_manager',
    '总部经理': 'hq_manager',
    '总部人员': 'hr_manager',
    '总部人事': 'hr_manager',
    '总部营运': 'hq_manager',
    '出纳': 'cashier',
    'custom_出纳': 'cashier',
    '门店店长': 'store_manager',
    '店长': 'store_manager',
    '门店出品经理': 'store_production_manager',
    '门店员工': 'store_employee',
    '员工': 'store_employee',
    '人事经理': 'hr_manager'
  };
  return map[v] || v;
}

function isInactiveStatus(input) {
  const v = String(input || '').trim().toLowerCase();
  if (!v) return false;
  return ['inactive', 'disabled', 'disable', 'off', '0', 'resigned', 'leave', 'left', '离职', '禁用', '停用'].includes(v);
}

function isUuid(input) {
  const v = String(input || '').trim();
  if (!v) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function normalizeCreatedByUuid(input) {
  const v = String(input || '').trim();
  return isUuid(v) ? v : null;
}

app.get('/api/state', authRequired, async (req, res) => {
  try {
    const r = await pool.query('select data from hrms_state where key = $1 limit 1', ['default']);
    const row = r.rows?.[0] || null;
    if (!row) return res.status(404).json({ error: 'not_found' });
    return res.json({ data: row.data });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.put('/api/state', authRequired, async (req, res) => {
  if (String(req.user?.role || '') !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const data = req.body?.data;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'missing_data' });
  }
  try {
    await pool.query(
      `insert into hrms_state (key, data, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (key) do update set data = excluded.data, updated_at = now()`,
      ['default', JSON.stringify(data)]
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/health', async (req, res) => {
  const missing = requireEnv();
  if (missing.length) {
    return res.status(500).json({ ok: false, missing });
  }
  try {
    const r = await pool.query('select now() as now');
    const ossConfigured = !!getOssClient();
    const cosConfigured = !!getCosClient();
    const uploads = ensureUploadsDir();
    return res.json({ ok: true, now: new Date().toISOString(), storage: { ossConfigured, cosConfigured }, uploads });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/version', async (req, res) => {
  try {
    const out = {
      startedAt: STARTED_AT,
      server: {
        indexMtime: null
      },
      frontend: {
        workingFixedMtime: null,
        swMtime: null,
        swCacheName: null
      }
    };

    try {
      const st = fs.statSync(__filename);
      out.server.indexMtime = st?.mtime ? st.mtime.toISOString() : null;
    } catch (e) {}

    try {
      const webRootDir = path.resolve(__dirname, '..');
      const wf = path.join(webRootDir, 'working-fixed.html');
      const sw = path.join(webRootDir, 'sw.js');
      if (fs.existsSync(wf)) {
        const st = fs.statSync(wf);
        out.frontend.workingFixedMtime = st?.mtime ? st.mtime.toISOString() : null;
      }
      if (fs.existsSync(sw)) {
        const st2 = fs.statSync(sw);
        out.frontend.swMtime = st2?.mtime ? st2.mtime.toISOString() : null;
        try {
          const head = String(fs.readFileSync(sw, 'utf8') || '').split(/\r?\n/).slice(0, 3).join('\n');
          const m = head.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
          out.frontend.swCacheName = m && m[1] ? String(m[1]) : null;
        } catch (e3) {}
      }
    } catch (e) {}

    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/exam-results', authRequired, async (req, res) => {
  const role = String(req.user?.role || '').trim();
  const isPrivileged = role === 'admin' || role === 'hq_manager' || role === 'store_manager';
  const limit = Math.min(200, Math.max(1, Number(req.query?.limit || 100)));
  try {
    if (isPrivileged) {
      const r = await pool.query(
        `select id, assignment_id, user_key, created_at, started_at, submitted_at, time_used_seconds, auto_submitted, set_index, total, correct, score, answers
         from exam_results
         order by created_at desc
         limit $1`,
        [limit]
      );
      return res.json({ items: r.rows || [] });
    }

    const userKey = String(req.user?.username || '').trim();
    const r = await pool.query(
      `select id, assignment_id, user_key, created_at, started_at, submitted_at, time_used_seconds, auto_submitted, set_index, total, correct, score, answers
       from exam_results
       where user_key = $1
       order by created_at desc
       limit $2`,
      [userKey, limit]
    );
    return res.json({ items: r.rows || [] });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/exam-results', authRequired, async (req, res) => {
  const userKey = String(req.user?.username || '').trim() || 'unknown';
  const assignmentIdRaw = req.body?.assignmentId;
  const assignmentId = assignmentIdRaw ? String(assignmentIdRaw).trim() : null;
  const startedAt = req.body?.startedAt ? String(req.body.startedAt).trim() : null;
  const submittedAt = req.body?.submittedAt ? String(req.body.submittedAt).trim() : null;
  const timeUsedSeconds = req.body?.timeUsedSeconds == null ? null : Number(req.body.timeUsedSeconds);
  const autoSubmitted = !!req.body?.autoSubmitted;
  const setIndex = req.body?.setIndex == null ? null : Number(req.body.setIndex);
  const total = req.body?.total == null ? null : Number(req.body.total);
  const correct = req.body?.correct == null ? null : Number(req.body.correct);
  const score = req.body?.score == null ? null : Number(req.body.score);
  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];

  if (total == null || score == null) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  try {
    const r = await pool.query(
      `insert into exam_results (assignment_id, user_key, started_at, submitted_at, time_used_seconds, auto_submitted, set_index, total, correct, score, answers)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning id, assignment_id, user_key, created_at, started_at, submitted_at, time_used_seconds, auto_submitted, set_index, total, correct, score, answers`,
      [
        assignmentId || null,
        userKey,
        startedAt || null,
        submittedAt || null,
        Number.isFinite(timeUsedSeconds) ? Math.max(0, Math.floor(timeUsedSeconds)) : null,
        autoSubmitted,
        Number.isFinite(setIndex) ? Math.max(0, Math.floor(setIndex)) : null,
        Number.isFinite(total) ? Math.max(0, Math.floor(total)) : null,
        Number.isFinite(correct) ? Math.max(0, Math.floor(correct)) : null,
        Number.isFinite(score) ? Math.max(0, Math.floor(score)) : null,
        JSON.stringify(answers || [])
      ]
    );
    return res.json({ item: r.rows?.[0] || null });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/knowledge/:id/file', authRequiredOrQueryToken, async (req, res) => {
  const id = String(req.params?.id || '').trim();
  if (!id) return res.status(400).json({ error: 'missing_id' });
  try {
    const r = await pool.query(
      `select file_path, file_type
       from knowledge_base
       where id = $1
       limit 1`,
      [id]
    );
    const row = r.rows?.[0] || null;
    if (!row?.file_path) return res.status(404).json({ error: 'not_found' });

    const filePath = String(row.file_path || '').trim();
    const resolveUploadsFile = (p) => {
      const raw = String(p || '').trim();
      if (!raw) return null;

      // 1) absolute path under uploadsDir
      try {
        if (path.isAbsolute(raw)) {
          const absNorm = path.resolve(raw);
          const upNorm = path.resolve(uploadsDir) + path.sep;
          if (absNorm.startsWith(upNorm)) return absNorm;
        }
      } catch (e) {}

      // 2) /uploads/... OR uploads/...
      const rel1 = raw.replace(/^\/uploads\//, '').replace(/^uploads\//, '');
      // also tolerate leading slash-less single filename
      const rel = rel1;

      // Disallow traversal
      const normalized = path.posix.normalize(rel).replace(/^\/+/, '');
      if (!normalized || normalized === '.' || normalized.includes('..')) return null;

      return path.join(uploadsDir, normalized);
    };

    const uploadsAbs = resolveUploadsFile(filePath);
    if (uploadsAbs) {
      if (!fs.existsSync(uploadsAbs)) return res.status(404).json({ error: 'not_found' });
      try {
        const ft = String(row.file_type || '').trim();
        const originalName = path.basename(uploadsAbs);
        const fallback = inferContentType({ declaredType: ft, originalName, mimeType: '' });
        if (fallback && !res.getHeader('Content-Type')) res.setHeader('Content-Type', fallback);
      } catch (e) {}
      return res.sendFile(uploadsAbs);
    }

    if (!/^https?:\/\//i.test(filePath)) {
      return res.status(400).json({ error: 'invalid_file_path' });
    }

    const upstreamHeaders = {};
    try {
      const r = String(req.headers?.range || '').trim();
      if (r) upstreamHeaders['Range'] = r;
    } catch (e) {}

    const upstream = await fetch(filePath, { headers: upstreamHeaders });
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: 'upstream_failed', status: upstream.status });
    }

    const contentType = upstream.headers.get('content-type') || '';
    const disposition = upstream.headers.get('content-disposition') || '';
    const contentRange = upstream.headers.get('content-range') || '';
    const acceptRanges = upstream.headers.get('accept-ranges') || '';
    const contentLength = upstream.headers.get('content-length') || '';
    if (contentType) res.setHeader('Content-Type', contentType);
    if (disposition) res.setHeader('Content-Disposition', disposition);
    if (contentRange) res.setHeader('Content-Range', contentRange);
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
    if (contentLength) res.setHeader('Content-Length', contentLength);

    res.status(upstream.status || 200);

    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => {
      try {
        res.end();
      } catch (e) {}
    });
    return nodeStream.pipe(res);
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.put('/api/stores/:id', authRequired, async (req, res) => {
  const id = String(req.params?.id || '').trim();
  if (!id) return res.status(400).json({ error: 'missing_id' });

  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'missing_name' });

  const address = String(req.body?.address || '').trim();
  const city = String(req.body?.city || '').trim();
  const floor = String(req.body?.floor || '').trim();
  const managerName = String(req.body?.managerName || '').trim();
  const phone = String(req.body?.phone || '').trim();
  const openDate = String(req.body?.openDate || '').trim() || null;
  const isActive = req.body?.status ? String(req.body.status) === 'active' : true;

  try {
    const r = await pool.query(
      `update stores
       set name=$2, address=$3, city=$4, floor=$5, manager_name=$6, phone=$7, open_date=$8, is_active=$9
       where id=$1
       returning id, name, address, city, floor, manager_name, phone, open_date, is_active, created_at, updated_at`,
      [id, name, address || null, city || null, floor || null, managerName || null, phone || null, openDate, isActive]
    );
    if (!r.rows?.[0]) return res.status(404).json({ error: 'not_found' });
    return res.json({ item: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

// Local dev test accounts (used when DB is unavailable)
const LOCAL_TEST_ACCOUNTS = [
  { id: 1, username: 'admin', password: 'admin123', name: '系统管理员', role: 'admin' }
];

async function storeSessionNonce(uname, nonce) {
  const key = String(uname || '').trim().toLowerCase();
  if (!key) return;
  try {
    await pool.query(
      `insert into user_sessions (username, session_nonce, updated_at)
       values ($1, $2, now())
       on conflict (username) do update set session_nonce = $2, updated_at = now()`,
      [key, nonce]
    );
  } catch (e) {
    console.error('storeSessionNonce failed:', e?.message || e);
  }
}

app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '').trim();
  if (!username || !password) return res.status(400).json({ error: 'missing_credentials' });

  const sn = randomUUID().replace(/-/g, '').slice(0, 16);

  // Try database first if configured
  const missing = requireEnv();
  if (!missing.length) {
    try {
      const r = await pool.query(
        'select id, username, password_hash, real_name, role, is_active from users where username = $1 limit 1',
        [username]
      );
      const u = r.rows?.[0];
      if (u) {
        if (u.is_active === false) return res.status(403).json({ error: 'user_inactive' });
        const ok = await bcrypt.compare(password, String(u.password_hash || ''));
        if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

        // Sync role from shared-state (authoritative source for role edits made in frontend)
        let finalRole = normalizeRoleForJwt(u.role);
        let finalName = u.real_name;
        try {
          const sr = await pool.query('select data from hrms_state where key = $1 limit 1', ['default']);
          const sd = sr.rows?.[0]?.data;
          if (sd && typeof sd === 'object') {
            // employees first – real users live there
            const allState = (Array.isArray(sd.employees) ? sd.employees : []).concat(Array.isArray(sd.users) ? sd.users : []);
            const stateUser = allState.find(x => String(x?.username || '').trim().toLowerCase() === u.username.toLowerCase());
            if (stateUser) {
              const stateRole = normalizeRoleForJwt(stateUser.role);
              if (stateRole && stateRole !== 'store_employee') finalRole = stateRole;
              else if (stateRole) finalRole = stateRole;
              if (stateUser.name) finalName = String(stateUser.name).trim() || finalName;
            }
          }
        } catch (syncErr) {}

        await storeSessionNonce(u.username, sn);
        const token = jwt.sign(
          { id: u.id, username: u.username, name: finalName, role: finalRole, sn },
          JWT_SECRET,
          { expiresIn: '14d' }
        );
        return res.json({
          token,
          user: { id: u.id, username: u.username, name: finalName, role: finalRole }
        });
      }
    } catch (dbErr) {
      console.log('DB login failed, falling back to local accounts:', dbErr.message);
    }
  }

  // Fallback to server-side saved state (hrms_state), so newly created employees can login.
  try {
    const r = await pool.query('select data from hrms_state where key = $1 limit 1', ['default']);
    const data = r.rows?.[0]?.data;
    if (data && typeof data === 'object') {
      const users = Array.isArray(data.users) ? data.users : [];
      const employees = Array.isArray(data.employees) ? data.employees : [];
      // employees first – real users live there
      const all = employees.concat(users);
      const found = all.find(u => String(u?.username || '').trim().toLowerCase() === username.toLowerCase());
      if (found) {
        if (isInactiveStatus(found.status)) return res.status(403).json({ error: 'user_inactive' });
        const pwd = String(found.password || '');
        if (pwd !== password) return res.status(401).json({ error: 'invalid_credentials' });

        const role = normalizeRoleForJwt(found.role);
        const canonicalUsername = String(found.username || '').trim() || username;
        const id = String(found.id || canonicalUsername);
        const name = String(found.name || found.real_name || found.realName || canonicalUsername);
        const secret = JWT_SECRET || 'local_dev_secret';
        await storeSessionNonce(canonicalUsername, sn);
        const token = jwt.sign({ id, username: canonicalUsername, name, role, sn }, secret, { expiresIn: '14d' });
        return res.json({ token, user: { id, username: canonicalUsername, name, role } });
      }
    }
  } catch (e) {
    console.log('State login failed:', e?.message || e);
  }

  // Fallback to local test accounts
  const localUser = LOCAL_TEST_ACCOUNTS.find(u => u.username === username && u.password === password);
  if (localUser) {
    const secret = JWT_SECRET || 'local_dev_secret';
    await storeSessionNonce(localUser.username, sn);
    const token = jwt.sign(
      { id: localUser.id, username: localUser.username, name: localUser.name, role: localUser.role, sn },
      secret,
      { expiresIn: '14d' }
    );
    return res.json({
      token,
      user: { id: localUser.id, username: localUser.username, name: localUser.name, role: localUser.role }
    });
  }

  return res.status(401).json({ error: 'invalid_credentials' });
});

app.get('/api/auth/me', authRequired, async (req, res) => {
  return res.json({ user: req.user });
});

app.get('/api/stores', authRequired, async (req, res) => {
  try {
    const r = await pool.query(
      `select id, name, address, city, floor, manager_name, phone, open_date, is_active, created_at, updated_at
       from stores
       order by created_at desc`
    );
    return res.json({ items: r.rows || [] });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/stores', authRequired, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'missing_name' });

  const address = String(req.body?.address || '').trim();
  const city = String(req.body?.city || '').trim();
  const floor = String(req.body?.floor || '').trim();
  const managerName = String(req.body?.managerName || '').trim();
  const phone = String(req.body?.phone || '').trim();
  const openDate = String(req.body?.openDate || '').trim() || null;
  const isActive = req.body?.status ? String(req.body.status) === 'active' : true;

  try {
    const r = await pool.query(
      `insert into stores (name, address, city, floor, manager_name, phone, open_date, is_active)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning id, name, address, city, floor, manager_name, phone, open_date, is_active, created_at, updated_at`,
      [name, address || null, city || null, floor || null, managerName || null, phone || null, openDate, isActive]
    );
    return res.json({ item: r.rows?.[0] || null });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/knowledge', authRequired, async (req, res) => {
  try {
    const r = await pool.query(
      `select id, title, category, tags, file_path, file_type, file_size, access_roles, access_departments, created_by, created_at, updated_at
       from knowledge_base
       order by created_at desc`
    );
    return res.json({ items: r.rows || [] });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

// 删除知识库条目（仅管理员）
app.delete('/api/knowledge/:id', authRequired, async (req, res) => {
  if (String(req.user?.role || '') !== 'admin') {
    return res.status(403).json({ error: 'admin_only' });
  }
  const id = String(req.params?.id || '').trim();
  if (!id) return res.status(400).json({ error: 'missing_id' });
  try {
    // 先查 file_path，尝试删除磁盘文件（文件不存在也不报错）
    const r = await pool.query('SELECT file_path FROM knowledge_base WHERE id = $1 LIMIT 1', [id]);
    const row = r.rows?.[0];
    if (!row) return res.status(404).json({ error: 'not_found' });

    const filePath = String(row.file_path || '').trim();
    if (filePath) {
      try {
        const rel = filePath.replace(/^\/uploads\//, '').replace(/^uploads\//, '');
        const normalized = path.posix.normalize(rel).replace(/^\/+/, '');
        if (normalized && normalized !== '.' && !normalized.includes('..')) {
          const abs = path.join(uploadsDir, normalized);
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
        }
      } catch (e) {
        console.log('knowledge delete file cleanup (non-fatal):', e?.message || e);
      }
    }

    await pool.query('DELETE FROM knowledge_base WHERE id = $1', [id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/knowledge/:id error:', e);
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/knowledge/presign', authRequired, async (req, res) => {
  if (String(req.user?.role || '') !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

  const oss = getOssClient();
  if (!oss) return res.status(500).json({ error: 'oss_not_configured' });

  const originalName = String(req.body?.originalName || 'file').trim() || 'file';
  const declaredType = String(req.body?.type || '').trim();
  const mimeType = String(req.body?.mimeType || '').trim();
  const size = Number(req.body?.size || 0);

  try {
    const ext = path.extname(originalName).slice(0, 16);
    const objectKey = `hrms/knowledge/${randomUUID()}${ext}`;
    const contentType = inferContentType({ declaredType, originalName, mimeType });
    const disposition = buildInlineContentDisposition(originalName);

    const signedUrl = oss.signatureUrl(objectKey, {
      method: 'PUT',
      expires: 60 * 20,
      'Content-Type': contentType,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': disposition
      }
    });
    const publicUrl = buildOssPublicUrl(objectKey);
    return res.json({
      objectKey,
      publicUrl,
      signedUrl,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': disposition
      },
      size
    });
  } catch (e) {
    return res.status(500).json({ error: 'presign_failed', message: String(e?.message || e) });
  }
});

app.post('/api/knowledge/direct', authRequired, async (req, res) => {
  if (String(req.user?.role || '') !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

  const title = String(req.body?.title || '').trim();
  const category = String(req.body?.category || '').trim();
  const fileType = String(req.body?.type || '').trim();
  const filePath = String(req.body?.filePath || '').trim();
  const size = Number(req.body?.size || 0);

  if (!title) return res.status(400).json({ error: 'missing_title' });
  if (!category) return res.status(400).json({ error: 'missing_category' });
  if (!filePath) return res.status(400).json({ error: 'missing_file_path' });

  try {
    const createdBy = normalizeCreatedByUuid(req.user?.id);
    const r = await pool.query(
      `insert into knowledge_base (title, content, category, tags, file_path, file_type, file_size, access_roles, access_departments, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       returning id, title, category, tags, file_path, file_type, file_size, access_roles, access_departments, created_by, created_at, updated_at`,
      [title, '', category || null, null, filePath, fileType || null, size || null, null, null, createdBy]
    );
    return res.json({ item: r.rows?.[0] || null });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/knowledge', authRequired, knowledgeUpload.single('file'), async (req, res) => {
  if (String(req.user?.role || '') !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

  const title = String(req.body?.title || '').trim();
  const category = String(req.body?.category || '').trim();
  const fileType = String(req.body?.type || '').trim() || String(req.file?.mimetype || '').trim();
  const size = Number(req.file?.size || 0);
  if (!title) return res.status(400).json({ error: 'missing_title' });
  if (!category) return res.status(400).json({ error: 'missing_category' });
  if (!req.file) return res.status(400).json({ error: 'missing_file' });

  const localPath = String(req.file?.path || '').trim();
  let filePath = `/uploads/${req.file.filename}`;

  // Insert first, respond fast. Cloud upload runs asynchronously.
  let inserted = null;
  try {
    const createdBy = normalizeCreatedByUuid(req.user?.id);
    const r = await pool.query(
      `insert into knowledge_base (title, content, category, tags, file_path, file_type, file_size, access_roles, access_departments, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       returning id, title, category, tags, file_path, file_type, file_size, access_roles, access_departments, created_by, created_at, updated_at`,
      [title, '', category || null, null, filePath, fileType || null, size || null, null, null, createdBy]
    );
    inserted = r.rows?.[0] || null;
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }

  // Return immediately so frontend can show success.
  res.json({ item: inserted, queued: true });

  // Async cloud upload best-effort; if success, update DB and delete local file.
  (async () => {
    try {
      if (!localPath || !inserted?.id) return;
      const orig = String(req.file?.originalname || 'file');
      const ext = path.extname(orig).slice(0, 16);
      const objectKey = `hrms/knowledge/${randomUUID()}${ext}`;
      const contentType = inferContentType({
        declaredType: req.body?.type,
        originalName: orig,
        mimeType: req.file?.mimetype
      });

      let finalUrl = '';
      const cos = getCosClient();
      if (cos) {
        await new Promise((resolve, reject) => {
          cos.sliceUploadFile(
            {
              Bucket: COS_BUCKET,
              Region: COS_REGION,
              Key: objectKey,
              FilePath: localPath
            },
            (err, data) => {
              if (err) return reject(err);
              return resolve(data);
            }
          );
        });
        try {
          await new Promise((resolve, reject) => {
            cos.putObjectCopy(
              {
                Bucket: COS_BUCKET,
                Region: COS_REGION,
                Key: objectKey,
                CopySource: `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/${objectKey}`,
                MetadataDirective: 'Replaced',
                ContentType: contentType,
                ContentDisposition: buildInlineContentDisposition(orig)
              },
              (err, data) => {
                if (err) return reject(err);
                return resolve(data);
              }
            );
          });
        } catch (e) {}
        finalUrl = buildCosPublicUrl(objectKey) || '';
      } else {
        const oss = getOssClient();
        if (oss) {
          const partSize = Math.max(1, OSS_PART_SIZE_MB) * 1024 * 1024;
          const parallel = Math.max(1, OSS_PARALLEL);
          await oss.multipartUpload(objectKey, localPath, {
            partSize,
            parallel,
            retryCount: Math.max(0, OSS_RETRY_COUNT),
            timeout: Math.max(10000, OSS_TIMEOUT_MS),
            headers: {
              'Content-Type': contentType,
              'Content-Disposition': buildInlineContentDisposition(orig)
            }
          });
          finalUrl = buildOssPublicUrl(objectKey) || '';
        }
      }

      if (!finalUrl) return;
      await pool.query('update knowledge_base set file_path = $1, updated_at = now() where id = $2', [finalUrl, inserted.id]);
      try {
        fs.unlinkSync(localPath);
      } catch (e) {}
    } catch (e) {
      console.log('Async knowledge cloud upload failed:', e?.message || e);
    }
  })();
});

app.listen(PORT, HOST, async () => {
  console.log(`hrms-server listening on ${HOST}:${PORT}`);
  // Migration: normalize all roles to 7 built-in roles + set specific user assignments
  try {
    const state = (await getSharedState()) || {};
    let changed = false;
    const cleanup = cleanupLegacyTestState(state);
    if (cleanup.changed) {
      Object.assign(state, cleanup.state);
      changed = true;
      console.log('[migration] Removed legacy built-in test accounts/data');
    }
    const ALLOWED_ROLES = ['admin', 'hq_manager', 'store_manager', 'store_employee', 'cashier', 'hr_manager', 'store_production_manager'];
    const ROLE_MAP = {
      'hq_employee': 'hr_manager',
      '总部人员': 'hr_manager',
      '总部人事': 'hr_manager',
      '人事经理': 'hr_manager',
      '总部HR': 'hr_manager',
      '总部营运': 'hq_manager',
      '总部经理': 'hq_manager',
      '总部管理层': 'hq_manager',
      '总部管理': 'hq_manager',
      '出纳': 'cashier',
      'custom_出纳': 'cashier',
      '总部出纳': 'cashier',
      '门店店长': 'store_manager',
      '店长': 'store_manager',
      '门店出品经理': 'store_production_manager',
      '出品经理': 'store_production_manager',
      '门店员工': 'store_employee',
      '员工': 'store_employee',
      '管理员': 'admin',
      '系统管理员': 'admin'
    };
    // Specific user role assignments
    const USER_ROLE_OVERRIDES = {
      '徐彬': 'hq_manager',
      '李艳玲': 'cashier',
      '高赟': 'hr_manager',
      '喻峰': 'store_manager',
      '黎永荣': 'store_production_manager',
      '李丽丽': 'store_employee'
    };
    for (const list of [state.users, state.employees]) {
      if (!Array.isArray(list)) continue;
      for (const u of list) {
        const name = String(u?.name || '').trim();
        const oldRole = String(u?.role || '').trim();
        // Apply specific user overrides first
        if (USER_ROLE_OVERRIDES[name]) {
          if (oldRole !== USER_ROLE_OVERRIDES[name]) {
            console.log(`[migration] ${name}: ${oldRole} -> ${USER_ROLE_OVERRIDES[name]}`);
            u.role = USER_ROLE_OVERRIDES[name];
            changed = true;
          }
          continue;
        }
        // Normalize known legacy/Chinese role names
        if (ROLE_MAP[oldRole]) {
          console.log(`[migration] ${name}: ${oldRole} -> ${ROLE_MAP[oldRole]}`);
          u.role = ROLE_MAP[oldRole];
          changed = true;
          continue;
        }
        // Any custom_ or unknown role -> default to store_employee
        if (oldRole && !ALLOWED_ROLES.includes(oldRole)) {
          console.log(`[migration] ${name}: ${oldRole} -> store_employee (unknown role)`);
          u.role = 'store_employee';
          changed = true;
        }
      }
    }

    // Normalize approvalFlows step tokens to built-in roles
    const normalizeFlowToken = (tok) => {
      const t = String(tok || '').trim();
      if (!t) return '';
      if (t === 'manager') return 'manager';
      if (t.startsWith('username:')) return t;
      if (t.startsWith('role:')) {
        const rid0 = t.slice('role:'.length).trim();
        const rid = ROLE_MAP[rid0] || rid0;
        if (rid === 'store_employee') return 'role:store_employee';
        if (ALLOWED_ROLES.includes(rid)) return 'role:' + rid;
        return 'role:store_employee';
      }
      const mapped = ROLE_MAP[t] || t;
      if (ALLOWED_ROLES.includes(mapped)) return mapped;
      // legacy labels
      if (mapped === 'hr_manager') return 'hr_manager';
      if (mapped === 'hq_manager') return 'hq_manager';
      if (mapped === 'cashier') return 'cashier';
      if (mapped === 'store_manager') return 'store_manager';
      if (mapped === 'store_production_manager') return 'store_production_manager';
      if (mapped === 'store_employee') return 'store_employee';
      return 'store_employee';
    };
    if (state.approvalFlows && typeof state.approvalFlows === 'object') {
      const flows = state.approvalFlows;
      Object.keys(flows).forEach((k) => {
        const cfg = flows[k];
        if (!cfg || typeof cfg !== 'object') return;
        const steps = Array.isArray(cfg.steps) ? cfg.steps : [];
        if (!steps.length) return;
        const nextSteps = steps.map(s => normalizeFlowToken(s)).filter(Boolean);
        const same = nextSteps.length === steps.length && nextSteps.every((v, i) => String(v) === String(steps[i]));
        if (!same) {
          flows[k] = { ...cfg, steps: nextSteps };
          changed = true;
          console.log(`[migration] Normalized approvalFlows.${k}.steps`);
        }
      });
      state.approvalFlows = flows;
    }

    // Also clean up orgDict custom roles if present
    if (state.orgDict && Array.isArray(state.orgDict.roles)) {
      const before = state.orgDict.roles.length;
      state.orgDict.roles = [];
      if (before > 0) { changed = true; console.log(`[migration] Cleared ${before} custom roles from orgDict`); }
    }
    if (changed) {
      await saveSharedState(state);
      console.log('[migration] Role cleanup complete');
    }
  } catch (e) {
    console.error('[migration] role cleanup failed:', e?.message || e);
  }
});

// ── Attendance Check-in APIs ──

app.post('/api/checkin', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  try {
    const state = (await getSharedState()) || {};
    const user = stateFindUserRecord(state, username);
    const userStore = String(user?.store || req.body?.store || '').trim();
    const type = req.body?.type === 'clock_out' ? 'clock_out' : 'clock_in';
    const lat = Number(req.body?.latitude);
    const lng = Number(req.body?.longitude);
    const noGps = !!req.body?.noGps;
    const faceMatch = !!req.body?.faceMatch;
    const faceScore = Number(req.body?.faceScore || 0);
    const photoUrl = String(req.body?.photoUrl || '').trim() || null;
    const note = String(req.body?.note || '').trim() || null;

    if (!noGps && (!Number.isFinite(lat) || !Number.isFinite(lng))) {
      return res.status(400).json({ error: 'missing_location', message: '请开启定位功能' });
    }

    // Bug 1: Prevent duplicate same-type check-in within 1 hour
    const dupCheck = await pool.query(
      `select id from checkin_records where lower(username) = lower($1) and type = $2 and check_time > now() - interval '1 hour' limit 1`,
      [username, type]
    );
    if (dupCheck.rows?.length) {
      const label = type === 'clock_in' ? '上班' : '下班';
      return res.status(400).json({ error: 'duplicate_checkin', message: `1小时内已${label}打卡，请勿重复操作` });
    }

    // get store location from state
    const stores = Array.isArray(state.stores) ? state.stores : [];
    const storeObj = stores.find(s => String(s?.name || '').trim() === userStore);
    let distance = null;
    let status = 'normal';

    if (noGps) {
      // Client has no GPS (HTTP context or permission denied) — allow check-in but mark status
      status = 'no_gps';
    } else if (storeObj && Number.isFinite(Number(storeObj.latitude)) && Number.isFinite(Number(storeObj.longitude))) {
      distance = haversineDistance(lat, lng, Number(storeObj.latitude), Number(storeObj.longitude));
      distance = Math.round(distance * 100) / 100;
      if (distance > 10) {
        status = 'out_of_range';
        return res.status(400).json({ error: 'out_of_range', distance: Math.round(distance), message: `您距离门店${Math.round(distance)}米，超出打卡范围（10米）` });
      }
    } else {
      status = 'no_store_location';
    }

    if (!faceMatch && status === 'normal') {
      status = 'face_fail';
    }

    const r = await pool.query(
      `insert into checkin_records (username, store, type, check_time, latitude, longitude, distance_meters, face_match, face_score, photo_url, status, note)
       values ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9, $10, $11)
       returning *`,
      [username, userStore, type, lat, lng, distance, faceMatch, faceScore, photoUrl, status, note]
    );
    return res.json({ record: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/checkin/today', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  try {
    const r = await pool.query(
      `select * from checkin_records where lower(username) = lower($1) and check_time::date = current_date order by check_time asc`,
      [username]
    );
    return res.json({ records: r.rows || [] });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/checkin/records', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });

  const filterUser = String(req.query?.username || '').trim();
  const filterStore = String(req.query?.store || '').trim();
  const filterName = String(req.query?.name || '').trim();
  const start = safeDateOnly(req.query?.start);
  const end = safeDateOnly(req.query?.end);
  const filterStatus = String(req.query?.status || '').trim();

  try {
    const state = (await getSharedState()) || {};
    let conditions = [];
    let params = [];
    let idx = 1;

    if (role === 'admin' || role === 'hq_manager' || role === 'hr_manager') {
      // Admin, HQ manager, and HR manager can see all records
      if (filterUser) { conditions.push(`lower(username) = lower($${idx})`); params.push(filterUser); idx++; }
      if (filterStore) { conditions.push(`store = $${idx}`); params.push(filterStore); idx++; }
    } else if (role === 'store_manager') {
      // Store manager can see their own store's records
      const myStore = pickMyStoreFromState(state, username);
      if (myStore) { conditions.push(`store = $${idx}`); params.push(myStore); idx++; }
      else { conditions.push(`lower(username) = lower($${idx})`); params.push(username); idx++; }
      if (filterUser) { conditions.push(`lower(username) = lower($${idx})`); params.push(filterUser); idx++; }
    } else {
      // Everyone else (employee, cashier) sees only their own
      conditions.push(`lower(username) = lower($${idx})`); params.push(username); idx++;
    }

    // Name search: find usernames matching the search name
    if (filterName) {
      const users = Array.isArray(state?.users) ? state.users : [];
      const employees = Array.isArray(state?.employees) ? state.employees : [];
      const all = users.concat(employees);
      const matchedUsernames = all
        .filter(u => String(u?.name || '').includes(filterName))
        .map(u => String(u?.username || '').trim().toLowerCase())
        .filter(Boolean);
      if (matchedUsernames.length) {
        conditions.push(`lower(username) = any($${idx}::text[])`);
        params.push(matchedUsernames);
        idx++;
      } else {
        // No match found, return empty
        return res.json({ records: [] });
      }
    }

    if (start) { conditions.push(`check_time::date >= $${idx}::date`); params.push(start); idx++; }
    if (end) { conditions.push(`check_time::date <= $${idx}::date`); params.push(end); idx++; }
    if (filterStatus) { conditions.push(`status = $${idx}`); params.push(filterStatus); idx++; }

    const where = conditions.length ? 'where ' + conditions.join(' and ') : '';
    const r = await pool.query(
      `select * from checkin_records ${where} order by check_time desc limit 500`,
      params
    );
    // Build nameMap from shared state so frontend always gets real names (case-insensitive)
    const usersArr = Array.isArray(state?.users) ? state.users : [];
    const empsArr = Array.isArray(state?.employees) ? state.employees : [];
    const nameMap = {};
    usersArr.forEach(u => { if (u?.username) nameMap[String(u.username).toLowerCase()] = u.name || u.username; });
    empsArr.forEach(e => { if (e?.username) nameMap[String(e.username).toLowerCase()] = e.name || e.username; });
    const rows = (r.rows || []).map(row => ({
      ...row,
      display_name: nameMap[String(row.username || '').toLowerCase()] || row.username
    }));
    return res.json({ records: rows });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/checkin/:id/confirm', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  const canConfirm = role === 'admin' || role === 'hq_manager' || role === 'store_manager';
  if (!canConfirm) return res.status(403).json({ error: 'forbidden' });
  const id = String(req.params?.id || '').trim();
  const newStatus = String(req.body?.status || 'confirmed').trim();
  const note = String(req.body?.note || '').trim() || null;
  try {
    const r = await pool.query(
      `update checkin_records set status = $1, confirmed_by = $2, confirmed_at = now(), note = coalesce($3, note) where id = $4 returning *`,
      [newStatus, username, note, id]
    );
    if (!r.rows?.length) return res.status(404).json({ error: 'not_found' });
    return res.json({ record: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/checkin/summary', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  const filterStore = String(req.query?.store || '').trim();
  const month = String(req.query?.month || '').trim();
  if (!month) return res.status(400).json({ error: 'missing_month' });

  try {
    const state = (await getSharedState()) || {};
    let conditions = [`to_char(check_time, 'YYYY-MM') = $1`];
    let params = [month];
    let idx = 2;

    if (role === 'admin' || role === 'hq_manager') {
      if (filterStore) { conditions.push(`store = $${idx}`); params.push(filterStore); idx++; }
    } else if (role === 'store_manager') {
      const myStore = pickMyStoreFromState(state, username);
      if (myStore) { conditions.push(`store = $${idx}`); params.push(myStore); idx++; }
      else { conditions.push(`lower(username) = lower($${idx})`); params.push(username); idx++; }
    } else {
      conditions.push(`lower(username) = lower($${idx})`); params.push(username); idx++;
    }

    const where = conditions.join(' and ');
    const r = await pool.query(
      `select username, check_time::date as day, type, status, check_time
       from checkin_records where ${where} order by username, check_time asc`,
      params
    );
    // Attach display_name from shared state (case-insensitive)
    const usersArr = Array.isArray(state?.users) ? state.users : [];
    const empsArr = Array.isArray(state?.employees) ? state.employees : [];
    const nameMap = {};
    usersArr.forEach(u => { if (u?.username) nameMap[String(u.username).toLowerCase()] = u.name || u.username; });
    empsArr.forEach(e => { if (e?.username) nameMap[String(e.username).toLowerCase()] = e.name || e.username; });
    const rows = (r.rows || []).map(row => ({
      ...row,
      display_name: nameMap[String(row.username || '').toLowerCase()] || row.username
    }));

    // Calculate leave balance per employee for this month
    const leaveBalances = {};
    const leaveRecords = Array.isArray(state.leaveRecords) ? state.leaveRecords : [];
    const leaveOverrides = state.leaveBalanceOverrides || {};
    const [yr, mo] = month.split('-').map(Number);
    const daysInMonth = new Date(yr, mo, 0).getDate();

    const allUsernames = new Set();
    rows.forEach(row => allUsernames.add(String(row.username || '').toLowerCase()));

    allUsernames.forEach(uLower => {
      const emp = empsArr.find(e => String(e?.username || '').toLowerCase() === uLower)
        || usersArr.find(e => String(e?.username || '').toLowerCase() === uLower);
      if (!emp) return;
      const uname = String(emp.username || '').trim();

      // Base: 1 day off per week (count Sundays in month)
      let weeksInMonth = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        if (new Date(yr, mo - 1, d).getDay() === 0) weeksInMonth++;
      }
      let baseLeave = weeksInMonth;

      // Annual leave: 5 days/year if employed >= 1 year, prorated monthly
      const joinDate = String(emp.joinDate || emp.createdAt || '').trim();
      let annualLeave = 0;
      if (joinDate) {
        const jd = new Date(joinDate);
        const monthStart = new Date(yr, mo - 1, 1);
        const diffMs = monthStart - jd;
        const diffYears = diffMs / (365.25 * 24 * 60 * 60 * 1000);
        if (diffYears >= 1) {
          annualLeave = Math.round((5 / 12) * 100) / 100;
        }
      }

      // Used leave this month
      let usedLeave = 0;
      leaveRecords.forEach(lr => {
        if (String(lr.applicant || '').toLowerCase() !== uLower) return;
        if (lr.status !== 'approved') return;
        const sd = String(lr.startDate || '').trim();
        const ed = String(lr.endDate || '').trim();
        if (!sd || !ed) return;
        const leaveStart = new Date(sd);
        const leaveEnd = new Date(ed);
        const mStart = new Date(yr, mo - 1, 1);
        const mEnd = new Date(yr, mo, 0);
        if (leaveEnd < mStart || leaveStart > mEnd) return;
        const days = lr.days != null && lr.days !== '' ? Number(lr.days) : 0;
        if (days > 0) usedLeave += days;
      });

      const totalLeave = baseLeave + annualLeave;
      const remaining = Math.max(0, Math.round((totalLeave - usedLeave) * 100) / 100);
      const overrideKey = `${uname}_${month}`;
      const override = leaveOverrides[overrideKey];

      leaveBalances[uname] = {
        baseLeave,
        annualLeave: Math.round(annualLeave * 100) / 100,
        usedLeave,
        totalLeave: Math.round(totalLeave * 100) / 100,
        remaining: override != null ? Number(override) : remaining,
        overridden: override != null
      };
    });

    return res.json({ records: rows, leaveBalances });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

// API to manually override leave balance for an employee in a specific month
app.post('/api/checkin/leave-balance', authRequired, async (req, res) => {
  const role = String(req.user?.role || '').trim();
  if (role !== 'store_manager' && role !== 'admin' && role !== 'hq_manager') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const targetUsername = String(req.body?.username || '').trim();
  const month = String(req.body?.month || '').trim();
  const value = Number(req.body?.value);
  if (!targetUsername || !month || !Number.isFinite(value)) {
    return res.status(400).json({ error: 'missing_params' });
  }
  try {
    const state = (await getSharedState()) || {};
    const overrides = state.leaveBalanceOverrides || {};
    const key = `${targetUsername}_${month}`;
    overrides[key] = value;
    await saveSharedState({ ...state, leaveBalanceOverrides: overrides });
    return res.json({ ok: true, key, value });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

// Monthly attendance confirmation flow
app.post('/api/checkin/monthly-confirm', authRequired, async (req, res) => {
  const username = String(req.user?.username || '').trim();
  const role = String(req.user?.role || '').trim();
  if (!username) return res.status(400).json({ error: 'missing_user' });
  if (role !== 'store_manager' && role !== 'admin' && role !== 'hq_manager') {
    return res.status(403).json({ error: 'only_managers_can_confirm' });
  }
  const month = String(req.body?.month || '').trim();
  const store = String(req.body?.store || '').trim();
  const summary = req.body?.summary || {};
  if (!month) return res.status(400).json({ error: 'missing_month' });

  try {
    const state = (await getSharedState()) || {};
    const confirmations = Array.isArray(state.monthlyConfirmations) ? state.monthlyConfirmations : [];

    // Check if already submitted for this month+store
    const existing = confirmations.find(c => c.month === month && c.store === store && c.status !== 'rejected');
    if (existing) {
      return res.status(409).json({ error: 'already_submitted', id: existing.id });
    }

    const id = 'MC-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    const confirmation = {
      id,
      month,
      store: store || '',
      submitter: username,
      submitterRole: role,
      summary,
      status: 'pending_supervisor',
      createdAt: new Date().toISOString(),
      history: [{ action: 'submitted', by: username, at: new Date().toISOString() }]
    };

    // Create approval request for the monthly confirmation
    const applicantManager = pickManagerUsername(state, username);
    const hrManagerUsername = pickHrManagerUsername(state);

    // Flow: store_manager submit → supervisor approve → HR confirm → auto-generate
    const chain = [];
    if (applicantManager) chain.push(applicantManager);
    if (hrManagerUsername && hrManagerUsername !== applicantManager) chain.push(hrManagerUsername);

    if (chain.length > 0) {
      try {
        await pool.query(
          `INSERT INTO approval_requests (type, applicant_username, payload, status, approval_chain, current_step, store)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            'monthly_confirm',
            username,
            JSON.stringify({ month, store, summary, confirmationId: id }),
            'pending',
            JSON.stringify(chain),
            0,
            store || null
          ]
        );
      } catch (dbErr) {
        console.error('Failed to create monthly confirm approval:', dbErr);
      }
    } else {
      confirmation.status = 'approved';
      confirmation.approvedAt = new Date().toISOString();
    }

    confirmations.push(confirmation);
    await saveSharedState({ ...state, monthlyConfirmations: confirmations });

    // Send notification to first approver
    if (chain.length > 0) {
      const notifs = Array.isArray(state.notifications) ? state.notifications : [];
      notifs.push({
        id: 'NOTIF-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
        type: 'monthly_confirm',
        targetUser: chain[0],
        title: '【月度考勤确认】待审批',
        message: `${username} 提交了 ${month} ${store || '全部门店'} 的月度考勤确认，请审批。`,
        read: false,
        createdAt: new Date().toISOString()
      });
      await saveSharedState({ ...(await getSharedState()), notifications: notifs });
    }

    return res.json({ ok: true, confirmation });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.get('/api/checkin/monthly-confirm', authRequired, async (req, res) => {
  const month = String(req.query?.month || '').trim();
  try {
    const state = (await getSharedState()) || {};
    const confirmations = Array.isArray(state.monthlyConfirmations) ? state.monthlyConfirmations : [];
    const filtered = month ? confirmations.filter(c => c.month === month) : confirmations;
    return res.json({ confirmations: filtered });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.post('/api/stores/:name/location', authRequired, async (req, res) => {
  const role = String(req.user?.role || '').trim();
  if (role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const storeName = decodeURIComponent(String(req.params?.name || '').trim());
  const lat = Number(req.body?.latitude);
  const lng = Number(req.body?.longitude);
  const address = String(req.body?.address || '').trim();
  if (!storeName) return res.status(400).json({ error: 'missing_store' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'missing_location' });
  try {
    const state = (await getSharedState()) || {};
    const stores = Array.isArray(state.stores) ? state.stores.slice() : [];
    const idx = stores.findIndex(s => String(s?.name || '').trim() === storeName);
    if (idx < 0) return res.status(404).json({ error: 'store_not_found' });
    stores[idx] = { ...stores[idx], latitude: lat, longitude: lng, address: address || stores[idx].address || '' };
    await saveSharedState({ ...state, stores });
    return res.json({ store: stores[idx] });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
  }
});

app.use((err, req, res, next) => {
  if (!err) return next();
  try {
    if (err instanceof multer.MulterError) {
      const code = String(err.code || 'multer_error');
      if (code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'file_too_large' });
      }
      return res.status(400).json({ error: 'upload_error', code });
    }
  } catch (e) {}

  const msg = String(err?.message || err);
  if (/uploads_dir_not_writable/i.test(msg)) {
    return res.status(500).json({ error: 'uploads_dir_not_writable', message: msg });
  }
  return res.status(500).json({ error: 'server_error', message: msg });
});

ensureExamResultsTable();
ensureHrmsStateTable();
ensureApprovalTables();
ensureUserReadsTable();
ensureUserSessionsTable();
ensureCheckinTable();

setInterval(() => {
  (async () => {
    try {
      await ensureApprovalTables();
      const today = new Date();
      const y = today.getFullYear();
      const m = String(today.getMonth() + 1).padStart(2, '0');
      const d = String(today.getDate()).padStart(2, '0');
      const dateOnly = `${y}-${m}-${d}`;

      const r = await pool.query(
        `select id, payload, applicant_username
         from approval_requests
         where type = $1
           and status = $2
           and effective_date is not null
           and effective_date <= $3::date
           and executed_at is null
         order by effective_date asc
         limit 50`,
        ['offboarding', 'approved', dateOnly]
      );
      const items = r.rows || [];
      if (!items.length) return;

      const state = (await getSharedState()) || {};
      const employees = Array.isArray(state.employees) ? state.employees : [];
      let changed = false;
      for (const it of items) {
        const empUsername = String(it?.payload?.username || it?.payload?.employeeUsername || it?.payload?.applicant || it?.applicant_username || '').trim();
        if (!empUsername) continue;
        const idx = employees.findIndex(e => String(e?.username || '').toLowerCase() === empUsername.toLowerCase());
        if (idx < 0) continue;
        const old = employees[idx] || {};
        if (String(old.status || '') !== '离职' && String(old.status || '') !== 'inactive') {
          employees[idx] = { ...old, status: '离职', resignedAt: dateOnly };
          changed = true;
        }
      }

      if (changed) {
        await saveSharedState({ ...state, employees });
      }

      for (const it of items) {
        try {
          await pool.query('update approval_requests set executed_at = now(), updated_at = now() where id = $1', [it.id]);
        } catch (e) {}
      }
    } catch (e) {
      console.log('offboarding auto-disable job failed:', e?.message || e);
    }
  })();
}, 30 * 60 * 1000);

// ========== 培训专注度监控 API ==========

// 创建 attention_scores 表（如果不存在）
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attention_scores (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        name TEXT DEFAULT '',
        store TEXT DEFAULT '',
        material_id TEXT NOT NULL,
        material_title TEXT DEFAULT '',
        score INTEGER DEFAULT 0,
        duration_seconds INTEGER DEFAULT 0,
        total_samples INTEGER DEFAULT 0,
        attentive_samples INTEGER DEFAULT 0,
        avg_score INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    try {
      await pool.query('CREATE INDEX IF NOT EXISTS idx_attn_username ON attention_scores(username)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_attn_material ON attention_scores(material_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_attn_created ON attention_scores(created_at)');
    } catch (e) {}
  } catch (e) {
    console.log('attention_scores table init:', e?.message || e);
  }
})();

// 保存专注度分数
app.post('/api/attention-scores', authRequired, async (req, res) => {
  try {
    const username = String(req.user?.username || '').trim();
    if (!username) return res.status(400).json({ error: 'missing_user' });

    const materialId = String(req.body?.materialId || '').trim();
    const materialTitle = String(req.body?.materialTitle || '').trim();
    const score = Math.max(0, Math.min(100, Number(req.body?.score) || 0));
    const durationSeconds = Math.max(0, Number(req.body?.durationSeconds) || 0);
    const totalSamples = Math.max(0, Number(req.body?.totalSamples) || 0);
    const attentiveSamples = Math.max(0, Number(req.body?.attentiveSamples) || 0);
    const avgScore = Math.max(0, Math.min(100, Number(req.body?.avgScore) || 0));

    if (!materialId) return res.status(400).json({ error: 'missing_material_id' });

    // 获取用户姓名和门店
    const state = (await getSharedState()) || {};
    const users = Array.isArray(state.users) ? state.users : [];
    const employees = Array.isArray(state.employees) ? state.employees : [];
    const userObj = users.find(u => String(u?.username || '').toLowerCase() === username.toLowerCase())
      || employees.find(e => String(e?.username || '').toLowerCase() === username.toLowerCase());
    const name = String(userObj?.name || '').trim();
    const store = String(userObj?.store || '').trim();

    const id = 'attn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await pool.query(
      `INSERT INTO attention_scores (id, username, name, store, material_id, material_title, score, duration_seconds, total_samples, attentive_samples, avg_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, username, name, store, materialId, materialTitle, score, durationSeconds, totalSamples, attentiveSamples, avgScore]
    );

    res.json({ ok: true, id, score });
  } catch (e) {
    console.error('POST /api/attention-scores error:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// 查询专注度分数（管理员/经理可查全部，普通员工只能查自己）
app.get('/api/attention-scores', authRequired, async (req, res) => {
  try {
    const username = String(req.user?.username || '').trim();
    const role = String(req.user?.role || '').trim();
    const canSeeAll = role === 'admin' || role === 'hq_manager' || role === 'hr_manager' || role === 'store_manager';

    const filterUser = String(req.query?.username || '').trim();
    const filterMaterial = String(req.query?.materialId || '').trim();
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));

    let query = 'SELECT * FROM attention_scores WHERE 1=1';
    const params = [];
    let paramIdx = 1;

    if (!canSeeAll) {
      query += ` AND username = $${paramIdx++}`;
      params.push(username);
    } else if (filterUser) {
      query += ` AND username = $${paramIdx++}`;
      params.push(filterUser);
    }

    if (filterMaterial) {
      query += ` AND material_id = $${paramIdx++}`;
      params.push(filterMaterial);
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIdx++}`;
    params.push(limit);

    const r = await pool.query(query, params);
    res.json({ scores: r.rows || [] });
  } catch (e) {
    console.error('GET /api/attention-scores error:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// 专注度统计摘要（按用户汇总）
app.get('/api/attention-scores/summary', authRequired, async (req, res) => {
  try {
    const role = String(req.user?.role || '').trim();
    const canSeeAll = role === 'admin' || role === 'hq_manager' || role === 'hr_manager' || role === 'store_manager';
    if (!canSeeAll) return res.status(403).json({ error: 'forbidden' });

    const r = await pool.query(`
      SELECT username, name, store,
        COUNT(*) as session_count,
        ROUND(AVG(score)) as avg_score,
        SUM(duration_seconds) as total_duration,
        MAX(created_at) as last_session
      FROM attention_scores
      GROUP BY username, name, store
      ORDER BY avg_score ASC
    `);
    res.json({ summary: r.rows || [] });
  } catch (e) {
    console.error('GET /api/attention-scores/summary error:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});
