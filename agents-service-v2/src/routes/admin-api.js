import { Router } from 'express';
import { getConfig, getAllConfigs, upsertConfig, getConfigAuditLog } from '../services/config-service.js';
import { authRequired, requireRole } from '../middleware/auth.js';
import { query } from '../utils/db.js';

const r = Router();
const admin = [authRequired, requireRole('admin','hq_manager')];

// Agent configs
r.get('/agent-config', ...admin, async (req,res) => {
  const ids=['master','data_auditor','ops_supervisor','chief_evaluator','train_advisor','appeal','marketing_planner','marketing_executor','procurement_advisor'];
  const c={}; for(const id of ids) c[id]=await getConfig(`agent_config_${id}`)||{enabled:true,prompt:'',temperature:0.3,maxTokens:800};
  res.json({agents:c});
});
r.put('/agent-config/:id', ...admin, async (req,res) => {
  await upsertConfig(`agent_config_${req.params.id}`,req.body,req.user?.username);
  res.json({ok:true});
});

// Routing rules
r.get('/routing-rules', ...admin, async (req,res) => {
  res.json({rules: await getConfig('routing_rules')||[]});
});
r.put('/routing-rules', ...admin, async (req,res) => {
  await upsertConfig('routing_rules',req.body.rules||[],req.user?.username);
  res.json({ok:true});
});

// Scoring rules
r.get('/scoring-rules', ...admin, async (req,res) => {
  res.json({rules: await getConfig('scoring_rules')||{}});
});
r.put('/scoring-rules', ...admin, async (req,res) => {
  await upsertConfig('scoring_rules',req.body.rules||{},req.user?.username);
  res.json({ok:true});
});

// System stats
r.get('/system-stats', authRequired, async (req,res) => {
  const [t,m,a] = await Promise.all([
    query('SELECT status,COUNT(*)::int as c FROM master_tasks GROUP BY status').catch(()=>({rows:[]})),
    query("SELECT COUNT(*)::int as c FROM agent_task_logs WHERE created_at>NOW()-INTERVAL '24h'").catch(()=>({rows:[{c:0}]})),
    query("SELECT COUNT(*)::int as c FROM anomaly_triggers WHERE trigger_date=CURRENT_DATE").catch(()=>({rows:[{c:0}]}))
  ]);
  res.json({tasks:t.rows, messages24h:m.rows[0]?.c||0, anomaliesToday:a.rows[0]?.c||0});
});

// Audit log
r.get('/audit-log', ...admin, async (req,res) => {
  const log = await getConfigAuditLog(req.query.key||null, parseInt(req.query.limit)||50);
  res.json({log});
});

// All configs list
r.get('/config', ...admin, async (req,res) => {
  res.json({configs: await getAllConfigs()});
});
r.put('/config/:key', ...admin, async (req,res) => {
  await upsertConfig(req.params.key, req.body.value, null, req.user?.username);
  res.json({ok:true});
});

// ─── Marketing Campaigns CRUD ───
r.get('/campaigns', ...admin, async (req, res) => {
  const store = req.query.store || null;
  const status = req.query.status || null;
  let sql = 'SELECT * FROM marketing_campaigns WHERE 1=1';
  const params = [];
  if (store) { params.push(`%${store}%`); sql += ` AND store ILIKE $${params.length}`; }
  if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
  sql += ' ORDER BY created_at DESC LIMIT 50';
  const result = await query(sql, params);
  res.json({ campaigns: result.rows });
});

r.post('/campaigns', ...admin, async (req, res) => {
  const { store, title, description, status, start_date, end_date, target_metric, target_value, budget_amount, notes } = req.body;
  const result = await query(
    `INSERT INTO marketing_campaigns (store, title, description, status, start_date, end_date, target_metric, target_value, budget_amount, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [store, title, description, status || 'planned', start_date, end_date, target_metric, target_value, budget_amount, notes, req.user?.username || 'admin']
  );
  res.json({ ok: true, campaign: result.rows[0] });
});

r.put('/campaigns/:id', ...admin, async (req, res) => {
  const { title, description, status, start_date, end_date, target_metric, target_value, actual_value, budget_amount, spent_amount, notes } = req.body;
  await query(
    `UPDATE marketing_campaigns SET title=COALESCE($1,title), description=COALESCE($2,description),
     status=COALESCE($3,status), start_date=COALESCE($4,start_date), end_date=COALESCE($5,end_date),
     target_metric=COALESCE($6,target_metric), target_value=COALESCE($7,target_value),
     actual_value=COALESCE($8,actual_value), budget_amount=COALESCE($9,budget_amount),
     spent_amount=COALESCE($10,spent_amount), notes=COALESCE($11,notes), updated_at=NOW()
     WHERE id=$12`,
    [title, description, status, start_date, end_date, target_metric, target_value, actual_value, budget_amount, spent_amount, notes, req.params.id]
  );
  res.json({ ok: true });
});

r.delete('/campaigns/:id', ...admin, async (req, res) => {
  await query('DELETE FROM marketing_campaigns WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ─── Marketing Templates ───
r.get('/templates', ...admin, async (req, res) => {
  const result = await query('SELECT * FROM marketing_templates ORDER BY success_rate DESC');
  res.json({ templates: result.rows });
});
r.post('/templates', ...admin, async (req, res) => {
  const { name, category, description, actions, expected_roi, budget_range, duration_days } = req.body;
  const result = await query(
    `INSERT INTO marketing_templates (name, category, description, actions, expected_roi, budget_range, duration_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [name, category, description, JSON.stringify(actions), expected_roi, budget_range, duration_days]
  );
  res.json({ ok: true, template: result.rows[0] });
});
r.delete('/templates/:id', ...admin, async (req, res) => {
  await query('DELETE FROM marketing_templates WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ─── Store-level Metrics Filtering ───
r.get('/metrics', authRequired, async (req, res) => {
  const user = req.user;
  const store = req.query.store || user?.store || null;
  // 门店级权限: 非admin/hq_manager只能看自己门店
  const isHQ = ['admin', 'hq_manager'].includes(user?.role);
  let sql = `SELECT date, store, actual_revenue, budget_rate, dine_traffic, dine_orders,
             delivery_actual, efficiency, actual_margin FROM daily_reports WHERE 1=1`;
  const params = [];
  if (!isHQ && user?.store) {
    params.push(user.store);
    sql += ` AND store = $${params.length}`;
  } else if (store) {
    params.push(`%${store}%`);
    sql += ` AND store ILIKE $${params.length}`;
  }
  sql += ' ORDER BY date DESC LIMIT 60';
  const result = await query(sql, params);
  res.json({ metrics: result.rows, filtered: !isHQ });
});

// ─── Idempotency Key Persistence ───
r.get('/idempotency/:key', authRequired, async (req, res) => {
  const result = await query(
    `SELECT key, result, created_at FROM idempotency_keys WHERE key = $1 AND created_at > NOW() - INTERVAL '24h'`,
    [req.params.key]
  ).catch(() => ({ rows: [] }));
  res.json({ exists: result.rows.length > 0, data: result.rows[0] || null });
});

// ─── Agent Evaluation (Phase 7) ───
r.get('/agent-evaluation', ...admin, async (req, res) => {
  try {
    const { evaluateAllAgents } = await import('../services/agent-evaluation.js');
    const report = await evaluateAllAgents();
    res.json(report);
  } catch (e) { res.json({ error: e?.message }); }
});
r.get('/agent-evaluation/:id', ...admin, async (req, res) => {
  try {
    const { evaluateAgent } = await import('../services/agent-evaluation.js');
    const report = await evaluateAgent(req.params.id);
    res.json(report);
  } catch (e) { res.json({ error: e?.message }); }
});

// ─── Procurement Advice (Phase 7) ───
r.get('/procurement/:store', ...admin, async (req, res) => {
  try {
    const { generateProcurementAdvice } = await import('../services/procurement-agent.js');
    const advice = await generateProcurementAdvice(req.params.store);
    res.json(advice);
  } catch (e) { res.json({ error: e?.message }); }
});

// ─── Platform Data (Phase 6) ───
r.get('/platform/:platform/:store', ...admin, async (req, res) => {
  try {
    const { fetchPlatformData } = await import('../services/platform-integration.js');
    const result = await fetchPlatformData(req.params.platform, req.params.store);
    res.json(result);
  } catch (e) { res.json({ ok: false, error: e?.message }); }
});

// ─── Delivery Data Manual Upload ───
r.post('/delivery-data', ...admin, async (req, res) => {
  const { store, date, delivery_avg_rating, delivery_bad_reviews, delivery_commission,
          delivery_new_followers, delivery_promotion_cost, delivery_cancel_count,
          delivery_actual, delivery_orders, delivery_pre_revenue } = req.body;
  if (!store || !date) return res.status(400).json({ error: 'store and date required' });
  try {
    const setClauses = [];
    const params = [store, date];
    const fields = { delivery_avg_rating, delivery_bad_reviews, delivery_commission,
      delivery_new_followers, delivery_promotion_cost, delivery_cancel_count,
      delivery_actual, delivery_orders, delivery_pre_revenue };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== '') {
        params.push(v);
        setClauses.push(`${k} = $${params.length}`);
      }
    }
    if (!setClauses.length) return res.status(400).json({ error: 'No delivery fields provided' });
    const result = await query(
      `UPDATE daily_reports SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE store ILIKE $1 AND date = $2::date RETURNING id, store, date`,
      params
    );
    if (!result.rows?.length) return res.status(404).json({ error: 'No daily_report found for this store/date' });
    res.json({ ok: true, updated: result.rows[0] });
  } catch (e) { res.status(500).json({ error: e?.message }); }
});

r.get('/delivery-data/:store', ...admin, async (req, res) => {
  const result = await query(
    `SELECT date, delivery_actual, delivery_orders, delivery_pre_revenue,
            delivery_avg_rating, delivery_bad_reviews, delivery_commission,
            delivery_new_followers, delivery_promotion_cost, delivery_cancel_count
     FROM daily_reports WHERE store ILIKE $1 AND date >= CURRENT_DATE - 30
     ORDER BY date DESC LIMIT 30`,
    [`%${req.params.store}%`]
  );
  res.json({ records: result.rows });
});

// ─── Agent Memory ───
r.get('/agent-memory/:agentId', ...admin, async (req, res) => {
  try {
    const { recallMemories } = await import('../services/agent-memory.js');
    const memories = await recallMemories(req.params.agentId, req.query.store || '', req.query.topic || '', 20);
    res.json({ memories });
  } catch (e) { res.json({ memories: [], error: e?.message }); }
});

export default r;
