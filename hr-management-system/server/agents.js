/**
 * HRMS Multi-Agent System — Feishu-First Architecture
 * BUILD_VERSION: 2026-02-27T19:00-v176
 *
 * HRMS = 大脑 + 数据处理中心
 * 飞书 = 唯一交互通道（单聊推送 / 接收回复）
 *
 * Agents:
 *   1. Data Auditor        (数据审计员) — 异常检测 → 飞书推送
 *   2. Operational Supervisor (营运督导员) — 图片审核 / 反作弊
 *   3. HR Agent           (HR专员) — 绩效评分 / 人事管理
 *   4. SOP Advisor         (SOP顾问)   — 知识库问答
 *
 * Flow:
 *   Scheduler → Agent 发现异常 → 飞书推送给店长
 *   店长在飞书回复文字/照片/语音 → webhook → Agent 处理 → 飞书回复
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import crypto from 'crypto';
import { 
  calculateStoreRating, 
  calculateEmployeeScore 
} from './new-scoring-model.js';
import { 
  AgentCommunicationSystem, 
  AgentCommunicationHelper 
} from './agent-communication-system.js';
import { pool as agentPool, setPool as setUnifiedAgentPool } from './utils/database.js';
import { safeExecute, safeErrorLog } from './utils/error-handler.js';
import { handleMarginMessage } from './margin-message-handler.js';
import { deduplicateMessage } from './message-deduplication.js';
import { getOpsAgentConfig, getBiAgentConfig, getCategoryAssigneeRoleMap } from './agent-config-manager.js';
import { buildSalesReport } from './bi-sales-detail.js';
import { generateWeeklyReport, generateMonthlyReport, formatReportMarkdown } from './bi-weekly-report.js';
import { extractRelationsFromBitableRecord, extractAnomalyRelations } from './knowledge-graph.js';
import { handleHqBrainMessage } from './hq-planner-agent.js';
import {
  getModelForRole,
  getTemperatureForRole,
  getMaxTokensForRole,
  trackLLMCall,
  getModelTier,
  getAvailableTools,
  isToolAllowed,
  isTierBudgetExceeded
} from './hq-brain-config.js';

// ─────────────────────────────────────────────
// 0. Config
// ─────────────────────────────────────────────

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const DEEPSEEK_VISION_MODEL = process.env.DEEPSEEK_VISION_MODEL || 'doubao-seed-2-0-pro-260215';
const QWEN_API_KEY = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '';
const QWEN_BASE_URL = process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen-max';
const DOUBAO_API_KEY = process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '';
const DOUBAO_BASE_URL = process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';

const FACTUAL_DATA_UNAVAILABLE_MESSAGE = '抱歉，我当前无法从数据库中获取相关凭证/数据，请您登录系统手动核查。';

// ── Provider 健康状态追踪 & 自动降级 ──
const _providerHealth = {
  deepseek: { healthy: true, failCount: 0, lastFailTime: 0, cooldownMs: 3 * 60 * 1000 },
  qwen:     { healthy: true, failCount: 0, lastFailTime: 0, cooldownMs: 3 * 60 * 1000 },
  doubao:   { healthy: true, failCount: 0, lastFailTime: 0, cooldownMs: 3 * 60 * 1000 }
};
const PROVIDER_FAIL_THRESHOLD = 2;
const PROVIDER_RECOVERY_CHECK_MS = 3 * 60 * 1000;

function markProviderFail(provider) {
  const h = _providerHealth[provider];
  if (!h) return;
  h.failCount += 1;
  h.lastFailTime = Date.now();
  if (h.failCount >= PROVIDER_FAIL_THRESHOLD) {
    h.healthy = false;
    console.error(`[LLM-FALLBACK] Provider ${provider} marked UNHEALTHY after ${h.failCount} consecutive failures`);
  }
}

function markProviderOk(provider) {
  const h = _providerHealth[provider];
  if (!h) return;
  const wasDown = !h.healthy;
  h.healthy = true;
  h.failCount = 0;
  if (wasDown) console.log(`[LLM-FALLBACK] Provider ${provider} recovered to HEALTHY`);
}

function isProviderHealthy(provider) {
  const h = _providerHealth[provider];
  if (!h) return true;
  if (h.healthy) return true;
  if (Date.now() - h.lastFailTime > PROVIDER_RECOVERY_CHECK_MS) return true;
  return false;
}

function getTextFallbackChain(primaryModel) {
  const primary = resolveModelProvider(primaryModel);
  const chain = [{ provider: primary, model: primaryModel }];
  if (primary !== 'qwen' && QWEN_API_KEY) chain.push({ provider: 'qwen', model: QWEN_MODEL });
  if (primary !== 'deepseek' && DEEPSEEK_API_KEY) chain.push({ provider: 'deepseek', model: DEEPSEEK_MODEL });
  return chain;
}

export function getProviderHealthStatus() {
  const now = Date.now();
  const result = {};
  for (const [k, v] of Object.entries(_providerHealth)) {
    result[k] = {
      healthy: v.healthy,
      failCount: v.failCount,
      lastFailAgo: v.lastFailTime ? `${Math.round((now - v.lastFailTime) / 1000)}s ago` : 'never',
      effectivelyAvailable: isProviderHealthy(k)
    };
  }
  return result;
}

function formatDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

const _biConversationCtx = new Map();
const _biLastToolCtx = new Map();
const BI_CONV_CTX_TTL = 10 * 60 * 1000;
const BI_CONV_CTX_MAX = 4;

const HARD_FACT_QUERY_PATTERNS = /(多少|几次|几天|几条|总数|占比|同比|环比|排名|top|倒数|趋势|营业额|营收|毛利|客诉|差评|桌访|达成率|人效|预测)/i;
const FACT_TOPIC_PATTERNS = /(营业额|营收|毛利|桌访|差评|收档|开档|原料|报损|投诉|考核|绩效|评分|门店|菜品|产品|订单|充值)/i;
const FOLLOWUP_HINT_PATTERNS = /(继续|还有|上面|那个|再说|再查|补充|详细|展开)/i;

const _agentQualityMetrics = {
  audits: 0,
  rewrites: 0,
  failedAudits: 0,
  numericViolations: 0,
  factualBlocks: 0,
  autonomousTasks: 0,
  lastUpdatedAt: ''
};

const AGENT_EVAL_CASES = [
  { text: '近7天门店营业额达成率怎么样', route: 'data_auditor', demand: 'hard' },
  { text: '帮我看下差评最多的菜品', route: 'data_auditor', demand: 'hard' },
  { text: '我要开市检查表', route: 'ops_supervisor', demand: 'soft' },
  { text: '这条绩效扣分我想申诉', route: 'appeal', demand: 'soft' },
  { text: '我想咨询离职流程', route: 'chief_evaluator', demand: 'soft' },
  { text: '这个SOP退款标准怎么执行', route: 'train_advisor', demand: 'soft' },
  { text: '你好', route: 'general', demand: 'none' }
];

function safeJsonParse(text, fallback = null) {
  const raw = String(text || '').trim();
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) {}
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return fallback;
  try { return JSON.parse(m[0]); } catch (e) { return fallback; }
}

function normalizePlainText(text, maxLen = 1200) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function detectFactDemand(text) {
  const q = String(text || '').trim();
  if (!q) return 'none';
  if (FACT_TOPIC_PATTERNS.test(q) && HARD_FACT_QUERY_PATTERNS.test(q)) return 'hard';
  if (FACT_TOPIC_PATTERNS.test(q)) return 'soft';
  return 'none';
}

function inferRouteByRules(text, hasImage = false) {
  if (hasImage) return { route: 'ops_supervisor', confidence: 1, reason: 'image_input' };
  const t = String(text || '').trim();
  if (!t) return null;

  const keywordMap = [
    { route: 'appeal', score: 2, rx: /(申诉|投诉|不公平|误判|恢复扣分|举报)/i },
    { route: 'ops_supervisor', score: 2, rx: /(开市|开档|收档|闭市|巡检|卫生|拍照|上传照片|检查表)/i },
    { route: 'data_auditor', score: 2, rx: /(营业额|营收|毛利|差评|桌访|达成率|排名|趋势|预测|分析|人效|报损|原料)/i },
    { route: 'chief_evaluator', score: 2, rx: /(绩效|评分|考核|奖金|离职|入职|转正|调岗|请假|社保|档案|薪资|工资)/i },
    { route: 'train_advisor', score: 2, rx: /(sop|标准|流程|培训|课件|带教|退款|赔付)/i }
  ];

  let best = { route: 'general', score: 0, reason: '' };
  for (const item of keywordMap) {
    if (item.rx.test(t)) {
      best = { route: item.route, score: item.score, reason: item.rx.source };
      break;
    }
  }
  if (best.score > 0) return { route: best.route, confidence: 0.92, reason: `rule:${best.reason}` };
  return null;
}

function extractNumericLiterals(text) {
  const vals = String(text || '').match(/-?\d+(?:\.\d+)?%?/g) || [];
  return vals.slice(0, 24);
}

function computeSourceCoverage(agentData = {}) {
  const rows = Array.isArray(agentData?.sourceAuditRows) ? agentData.sourceAuditRows : [];
  if (rows.length > 0) {
    const ok = rows.filter((x) => x?.status === 'ok').length;
    return Number((ok / rows.length).toFixed(2));
  }
  if (agentData?.deterministic || agentData?.grounded || agentData?.source) return 1;
  return 0;
}

function computeResponseConfidence(route, response, agentData = {}) {
  let score = 0.45;
  if (String(response || '').trim().length >= 18) score += 0.1;
  if (agentData?.deterministic) score += 0.25;
  if (agentData?.grounded) score += 0.2;
  if (agentData?.source) score += 0.1;
  if (agentData?.factualGuardrailBlocked) score -= 0.2;
  if (route === 'general') score -= 0.05;
  const coverage = computeSourceCoverage(agentData);
  score = score * 0.75 + coverage * 0.25;
  return Number(Math.max(0.05, Math.min(0.99, score)).toFixed(2));
}

function buildEvidencePackage(agentData = {}, context = {}) {
  const sourceAuditRows = Array.isArray(agentData?.sourceAuditRows) ? agentData.sourceAuditRows : [];
  return {
    route: String(agentData?.route || context?.route || '').trim(),
    store: String(context?.store || agentData?.store || '').trim(),
    brand: String(context?.brand || agentData?.brand || '').trim(),
    source: String(agentData?.source || '').trim(),
    deterministic: !!agentData?.deterministic,
    grounded: !!agentData?.grounded,
    sourceCoverage: computeSourceCoverage(agentData),
    sourceAudit: sourceAuditRows.slice(0, 8).map((x) => ({ key: x?.key, status: x?.status, count: x?.count, latest: x?.latest })),
    generatedAt: new Date().toISOString()
  };
}

function verifyNumericGrounding(responseText, evidenceText) {
  const answerNums = extractNumericLiterals(responseText);
  if (!answerNums.length) return { ok: true, missing: [] };
  const evidenceNums = new Set(extractNumericLiterals(evidenceText));
  if (!evidenceNums.size) return { ok: false, missing: answerNums.slice(0, 6) };
  const missing = answerNums.filter((x) => !evidenceNums.has(x));
  return { ok: missing.length <= Math.max(1, Math.floor(answerNums.length * 0.3)), missing: missing.slice(0, 6) };
}

function getBiConversationHistory(userId) {
  const entry = _biConversationCtx.get(userId);
  if (!entry) return [];
  if (Date.now() - entry.ts > BI_CONV_CTX_TTL) { _biConversationCtx.delete(userId); return []; }
  return entry.history || [];
}

function pushBiConversationTurn(userId, userText, assistantText, toolName) {
  const entry = _biConversationCtx.get(userId) || { ts: Date.now(), history: [] };
  entry.ts = Date.now();
  entry.history.push({ role: 'user', q: String(userText || '').slice(0, 120), tool: toolName || '' });
  entry.history.push({ role: 'assistant', a: String(assistantText || '').slice(0, 200) });
  if (entry.history.length > BI_CONV_CTX_MAX * 2) entry.history = entry.history.slice(-BI_CONV_CTX_MAX * 2);
  _biConversationCtx.set(userId, entry);
}

const BI_FUNCTION_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'query_sales_ranking',
      description: '查询门店菜品销售排行（可查询TOP或倒数，支持堂食/外卖，支持按销量/折前金额/实收金额排序）',
      parameters: {
        type: 'object',
        properties: {
          period_days: { type: 'integer', description: '统计天数，建议7-90', minimum: 1, maximum: 90 },
          limit: { type: 'integer', description: '返回条数，建议1-20', minimum: 1, maximum: 20 },
          sort_order: { type: 'string', enum: ['desc', 'asc'], description: 'desc=TOP最高，asc=倒数最低' },
          metric: { type: 'string', enum: ['sales_amount', 'revenue', 'qty'], description: 'sales_amount=折前金额，revenue=实收金额，qty=销量' },
          biz_type: { type: 'string', enum: ['all', 'dinein', 'takeaway'], description: 'all=全部，dinein=堂食，takeaway=外卖' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_complaint_product_ranking',
      description: '查询门店被投诉/差评最多或最少的产品排行',
      parameters: {
        type: 'object',
        properties: {
          period_days: { type: 'integer', description: '统计天数，建议7-90', minimum: 1, maximum: 90 },
          limit: { type: 'integer', description: '返回条数，建议1-20', minimum: 1, maximum: 20 },
          sort_order: { type: 'string', enum: ['desc', 'asc'], description: 'desc=投诉最多，asc=投诉最少' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_revenue_summary',
      description: '查询门店在指定天数内的营业额与达成率汇总',
      parameters: {
        type: 'object',
        properties: {
          period_days: { type: 'integer', description: '统计天数，建议1-60', minimum: 1, maximum: 60 }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_revenue_forecast_next_day',
      description: '预测门店下一日营业额（优先使用营业日报，缺失时回退销售明细）',
      parameters: {
        type: 'object',
        properties: {
          lookback_days: { type: 'integer', description: '回看天数，建议7-30', minimum: 3, maximum: 60 }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_table_visit',
      description: '查询门店桌访记录（不满意菜品、桌巡记录等）',
      parameters: {
        type: 'object',
        properties: {
          period_days: { type: 'integer', description: '统计天数，建议7-30', minimum: 1, maximum: 90 }
        }
      }
    }
  }
];

function parseToolArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object') return rawArgs;
  try {
    const parsed = JSON.parse(String(rawArgs));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_e) {
    return {};
  }
}

function clampInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function resolveToolPeriod(args = {}, fallbackDays = 30, originalQuery = '') {
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };
  const semanticPeriod = String(args.period || '').trim();
  const q = String(originalQuery || '').trim();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ms = 86400000;
  if (semanticPeriod === 'today' || /今[天日]/.test(q)) {
    return { days: 1, start: fmt(today), end: fmt(today), label: '今日' };
  }
  if (semanticPeriod === 'yesterday' || /昨[天日]/.test(q)) {
    const y = new Date(today - ms);
    return { days: 1, start: fmt(y), end: fmt(y), label: '昨日' };
  }
  if (semanticPeriod === 'last_week' || /上周/.test(q)) {
    const dow = today.getDay() || 7;
    const mon = new Date(today - (dow + 6) * ms);
    return { days: 7, start: fmt(mon), end: fmt(new Date(+mon + 6 * ms)), label: '上周' };
  }
  if (semanticPeriod === 'this_week' || /本周/.test(q)) {
    const dow = today.getDay() || 7;
    const mon = new Date(today - (dow - 1) * ms);
    return { days: dow, start: fmt(mon), end: fmt(today), label: '本周' };
  }
  if (semanticPeriod === 'last_month' || /上[个]?月/.test(q)) {
    const firstThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastOfPrev = new Date(firstThisMonth - ms);
    const firstOfPrev = new Date(lastOfPrev.getFullYear(), lastOfPrev.getMonth(), 1);
    return { days: Math.round((lastOfPrev - firstOfPrev) / ms) + 1, start: fmt(firstOfPrev), end: fmt(lastOfPrev), label: '上月' };
  }
  if (semanticPeriod === 'this_month' || /本月/.test(q)) {
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const d = Math.round((today - firstOfMonth) / ms) + 1;
    return { days: d, start: fmt(firstOfMonth), end: fmt(today), label: '本月' };
  }
  const nm = q.match(/近\s*(\d+)\s*天/);
  if (nm) {
    const n = parseInt(nm[1], 10) || fallbackDays;
    return { days: n, start: fmt(new Date(today - (n - 1) * ms)), end: fmt(today), label: `近${n}天` };
  }
  const days = clampInt(args.period_days, 1, 90, fallbackDays);
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return { days, start: fmt(start), end: fmt(end), label: `近${days}天` };
}

async function execBiToolSalesRanking(store, args = {}, originalQuery = '') {
  const targetStore = String(store || '').trim();
  if (!targetStore) return { ok: false, text: '当前账号未绑定门店，无法查询销售排行。', source: 'sales_raw' };

  const period = resolveToolPeriod(args, 30, originalQuery);
  const limit = clampInt(args.limit, 1, 20, 10);
  const metric = ['sales_amount', 'revenue', 'qty'].includes(String(args.metric || '')) ? String(args.metric) : 'sales_amount';
  const sortOrder = String(args.sort_order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const bizType = String(args.biz_type || 'all').toLowerCase();

  let bizSql = '';
  if (bizType === 'takeaway') {
    bizSql = ` AND lower(regexp_replace(COALESCE(s.biz_type, ''), '\\s+', '', 'g')) IN ('takeaway','delivery','外卖','外送')`;
  } else if (bizType === 'dinein') {
    bizSql = ` AND lower(regexp_replace(COALESCE(s.biz_type, ''), '\\s+', '', 'g')) IN ('dinein','堂食','店内','堂食点餐')`;
  }

  const metricSql = metric === 'qty'
    ? 'SUM(COALESCE(s.qty,0))'
    : metric === 'revenue'
      ? 'SUM(COALESCE(s.revenue,0))'
      : 'SUM(COALESCE(s.sales_amount,0))';

  try {
    const r = await pool().query(
      `SELECT
         s.dish_name,
         ROUND(SUM(COALESCE(s.qty,0))::numeric, 2) AS total_qty,
         ROUND(SUM(COALESCE(s.sales_amount,0))::numeric, 2) AS total_sales,
         ROUND(SUM(COALESCE(s.revenue,0))::numeric, 2) AS total_revenue
       FROM sales_raw s
       WHERE lower(regexp_replace(COALESCE(s.store,''), '\\s+', '', 'g')) = $1
         AND s.date BETWEEN $2 AND $3
         ${bizSql}
         AND COALESCE(s.dish_name,'') <> ''
       GROUP BY s.dish_name
       HAVING SUM(COALESCE(s.qty,0)) > 0
       ORDER BY ${metricSql} ${sortOrder}
       LIMIT ${limit}`,
      [normalizeStoreKey(targetStore), period.start, period.end]
    );

    const rows = r.rows || [];
    if (!rows.length) {
      return { ok: true, source: 'sales_raw', text: `📦 ${period.label}销售数据（${targetStore}）：暂无可用销售明细。` };
    }

    const title = sortOrder === 'ASC' ? `销售倒数${limit}` : `销售TOP${limit}`;
    const metricLabel = metric === 'qty' ? '销量' : metric === 'revenue' ? '实收金额' : '折前金额';
    const scope = bizType === 'all' ? '全部业态' : (bizType === 'dinein' ? '堂食' : '外卖');
    const lines = [`📦 ${title}（${targetStore}·${period.label}·${scope}）`, `排序口径：${metricLabel}`];
    rows.forEach((x, i) => {
      lines.push(`${i + 1}. ${x.dish_name}｜折前¥${Number(x.total_sales || 0).toFixed(0)}｜实收¥${Number(x.total_revenue || 0).toFixed(0)}｜销量${Number(x.total_qty || 0).toFixed(0)}份`);
    });
    lines.push('> 数据源：sales_raw（门店销售明细）');
    return { ok: true, source: 'sales_raw', text: lines.join('\n') };
  } catch (e) {
    return { ok: false, source: 'sales_raw', text: `销售排行查询失败：${e?.message || '未知错误'}` };
  }
}

async function execBiToolComplaintRanking(store, args = {}, originalQuery = '') {
  const targetStore = String(store || '').trim();
  if (!targetStore) return { ok: false, text: '当前账号未绑定门店，无法查询投诉排行。', source: 'bad_reviews' };

  const period = resolveToolPeriod(args, 30, originalQuery);
  const limit = clampInt(args.limit, 1, 20, 10);
  const asc = String(args.sort_order || 'desc').toLowerCase() === 'asc';
  const badReviewTableId = String(BITABLE_CONFIGS?.bad_reviews?.tableId || '').trim();

  try {
    let rows = [];
    if (badReviewTableId) {
      const r = await pool().query(
        `SELECT fields, created_at FROM feishu_generic_records WHERE table_id = $1 AND created_at >= $2::date ORDER BY updated_at DESC LIMIT 1000`,
        [badReviewTableId, period.start]
      );
      rows = (r.rows || []).filter((row) => {
        const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
        const rowStore = extractBitableFieldText(f['差评门店'] || f['门店'] || f['所属门店']);
        return isLikelySameStore(rowStore, targetStore);
      });
    }

    if (!rows.length) {
      const r2 = await pool().query(
        `SELECT agent_data as fields, created_at FROM agent_messages WHERE content_type = 'negative_review' AND created_at >= $1::date ORDER BY created_at DESC LIMIT 1000`,
        [period.start]
      );
      rows = (r2.rows || []).filter((row) => {
        const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
        return isLikelySameStore(String(f.store || ''), targetStore);
      });
    }

    if (!rows.length) {
      return { ok: true, source: 'bad_reviews', text: `📊 ${period.label}投诉数据（${targetStore}）：暂无投诉/差评记录。` };
    }

    const productTop = new Map();
    rows.forEach((row) => {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const product = extractBitableFieldText(f['差评产品'] || f.product_name || f['菜品'] || f['产品']);
      if (product && product !== '无') {
        productTop.set(product, (productTop.get(product) || 0) + 1);
      }
    });

    const sorted = Array.from(productTop.entries()).sort((a, b) => asc ? a[1] - b[1] : b[1] - a[1]).slice(0, limit);
    if (!sorted.length) {
      return { ok: true, source: 'bad_reviews', text: `📊 ${period.label}投诉数据（${targetStore}）：未提取到有效菜品字段。` };
    }

    const title = asc ? `投诉最少产品TOP${limit}` : `投诉最多产品TOP${limit}`;
    const lines = [`📊 ${title}（${targetStore}·${period.label}）`];
    sorted.forEach(([name, count], idx) => lines.push(`${idx + 1}. ${name}（${count}次）`));
    lines.push('> 数据源：差评报告（feishu_generic_records / agent_messages）');
    return { ok: true, source: 'bad_reviews', text: lines.join('\n') };
  } catch (e) {
    return { ok: false, source: 'bad_reviews', text: `投诉排行查询失败：${e?.message || '未知错误'}` };
  }
}

async function execBiToolRevenueSummary(store, args = {}, originalQuery = '') {
  const targetStore = String(store || '').trim();
  if (!targetStore) return { ok: false, text: '当前账号未绑定门店，无法查询营业汇总。', source: 'daily_reports' };

  const period = resolveToolPeriod(args, 7, originalQuery);
  try {
    const r = await pool().query(
      `SELECT date, actual_revenue, target_revenue, actual_margin, dianping_rating
       FROM daily_reports
       WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) = $1
         AND date BETWEEN $2 AND $3
       ORDER BY date DESC
       LIMIT 90`,
      [normalizeStoreKey(targetStore), period.start, period.end]
    );
    const rows = r.rows || [];
    if (rows.length) {
      const totalRevenue = rows.reduce((s, x) => s + (parseFloat(x.actual_revenue) || 0), 0);
      const totalTarget = rows.reduce((s, x) => s + (parseFloat(x.target_revenue) || 0), 0);
      const achieveRate = totalTarget > 0 ? (totalRevenue / totalTarget * 100).toFixed(1) : null;
      const avgMarginRows = rows.filter((x) => x.actual_margin != null);
      const avgMargin = avgMarginRows.length
        ? (avgMarginRows.reduce((s, x) => s + (parseFloat(x.actual_margin) || 0), 0) / avgMarginRows.length).toFixed(1)
        : null;

      const lines = [`📊 营业汇总（${targetStore}·${period.label}）`, `- 统计天数：${rows.length}天`, `- 累计营收：¥${totalRevenue.toFixed(0)}`];
      if (totalTarget > 0) lines.push(`- 目标营收：¥${totalTarget.toFixed(0)}（达成率 ${achieveRate}%）`);
      lines.push(`- 日均营收：¥${(totalRevenue / rows.length).toFixed(0)}`);
      if (avgMargin != null) lines.push(`- 平均毛利率：${avgMargin}%`);
      lines.push('> 数据源：daily_reports（营业日报）');
      return { ok: true, source: 'daily_reports', text: lines.join('\n') };
    }

    // Fallback: daily_reports 无数据时从 sales_raw 按日汇总
    const salesR = await pool().query(
      `SELECT s.date::text AS date, ROUND(SUM(COALESCE(s.revenue,0))::numeric, 2) AS day_revenue,
              ROUND(SUM(COALESCE(s.sales_amount,0))::numeric, 2) AS day_sales
       FROM sales_raw s
       WHERE lower(regexp_replace(coalesce(s.store,''), '\\s+', '', 'g')) = $1
         AND s.date BETWEEN $2 AND $3
       GROUP BY s.date
       ORDER BY s.date DESC
       LIMIT 90`,
      [normalizeStoreKey(targetStore), period.start, period.end]
    );
    const salesRows = salesR.rows || [];
    if (!salesRows.length) {
      return { ok: true, source: 'daily_reports', text: `📊 ${period.label}营业数据（${targetStore}）：暂无营业数据（日报和销售明细均无记录）。` };
    }
    const totalSalesRevenue = salesRows.reduce((s, x) => s + (parseFloat(x.day_revenue) || 0), 0);
    const totalSalesAmount = salesRows.reduce((s, x) => s + (parseFloat(x.day_sales) || 0), 0);
    const sLines = [`📊 营业汇总（${targetStore}·${period.label}）`, `- 统计天数：${salesRows.length}天`, `- 累计实收：¥${totalSalesRevenue.toFixed(0)}`];
    if (totalSalesAmount > 0) sLines.push(`- 累计折前：¥${totalSalesAmount.toFixed(0)}`);
    sLines.push(`- 日均实收：¥${(totalSalesRevenue / salesRows.length).toFixed(0)}`);
    sLines.push('> 数据源：sales_raw（销售明细按日汇总，营业日报暂无数据）');
    return { ok: true, source: 'sales_raw', text: sLines.join('\n') };
  } catch (e) {
    return { ok: false, source: 'daily_reports', text: `营业汇总查询失败：${e?.message || '未知错误'}` };
  }
}

async function execBiToolRevenueForecastNextDay(store, args = {}) {
  const targetStore = String(store || '').trim();
  if (!targetStore) return { ok: false, text: '当前账号未绑定门店，无法预测营业额。', source: 'daily_reports' };

  const lookbackDays = Math.max(28, clampInt(args.lookback_days, 14, 90, 60));
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (lookbackDays - 1));
  const startText = formatDate(start);
  const endText = formatDate(end);
  const tomorrow = new Date(end);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowText = formatDate(tomorrow);
  const tomorrowDow = tomorrow.getDay();

  const scoredForecast = (rows, revKey) => {
    if (!rows.length) return { pred: 0, min: 0, max: 0, sameDow: 0 };
    let sW = 0, sV = 0, lo = Infinity, hi = 0, sameDow = 0;
    for (const r of rows) {
      const v = Number(r[revKey]) || 0;
      if (v <= 0) continue;
      const d = new Date(String(r.date) + 'T00:00:00');
      if (!Number.isFinite(d.getTime())) continue;
      const dow = d.getDay();
      let sc = 1;
      if (dow === tomorrowDow) { sc += 3.0; sameDow++; }
      else { const adj = Math.min(Math.abs(dow - tomorrowDow), 7 - Math.abs(dow - tomorrowDow)); if (adj === 1) sc += 0.4; }
      const dd = Math.abs(Math.round((tomorrow.getTime() - d.getTime()) / 86400000));
      sc += Math.max(0, 1.0 - Math.min(1.0, dd / 60));
      sW += sc; sV += v * sc;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    if (sW <= 0) return { pred: 0, min: 0, max: 0, sameDow: 0 };
    return { pred: sV / sW, min: lo, max: hi, sameDow };
  };

  try {
    const dailyR = await pool().query(
      `SELECT date, actual_revenue
       FROM daily_reports
       WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) = $1
         AND date BETWEEN $2 AND $3
         AND actual_revenue IS NOT NULL
       ORDER BY date DESC
       LIMIT 60`,
      [normalizeStoreKey(targetStore), startText, endText]
    );
    const dailyRows = dailyR.rows || [];
    if (dailyRows.length >= 3) {
      const f = scoredForecast(dailyRows, 'actual_revenue');
      const pred = f.pred;
      const minV = f.min;
      const maxV = f.max;
      return {
        ok: true,
        source: 'daily_reports',
        text: `📈 明日营业额预测（${targetStore}）\n- 预测日期：${tomorrowText}（${'日一二三四五六'[tomorrowDow]}）\n- 预测值：¥${pred.toFixed(0)}\n- 参考区间：¥${minV.toFixed(0)} ~ ¥${maxV.toFixed(0)}\n- 同星期样本：${f.sameDow}天（权重×4）\n- 依据样本：近${lookbackDays}天营业日报（${dailyRows.length}天有效样本）\n> 算法：星期相似度加权+时间衰减，数据源：daily_reports`
      };
    }

    // 回退到 sales_raw 的按日实收汇总
    const salesR = await pool().query(
      `SELECT s.date, ROUND(SUM(COALESCE(s.revenue,0))::numeric, 2) AS day_revenue
       FROM sales_raw s
       WHERE lower(regexp_replace(coalesce(s.store,''), '\\s+', '', 'g')) = $1
         AND s.date BETWEEN $2 AND $3
       GROUP BY s.date
       ORDER BY s.date DESC
       LIMIT 60`,
      [normalizeStoreKey(targetStore), startText, endText]
    );
    const salesRows = salesR.rows || [];
    if (salesRows.length < 3) {
      // 兜底：扩大窗口到近60天，给出低置信预测，避免“等于没回答”
      const longR = await pool().query(
        `SELECT s.date, ROUND(SUM(COALESCE(s.revenue,0))::numeric, 2) AS day_revenue
         FROM sales_raw s
         WHERE lower(regexp_replace(coalesce(s.store,''), '\\s+', '', 'g')) = $1
           AND s.date BETWEEN $2 AND $3
         GROUP BY s.date
         ORDER BY s.date DESC
         LIMIT 60`,
        [normalizeStoreKey(targetStore), formatDate(new Date(Date.now() - 59 * 86400000)), endText]
      );
      const longRows = longR.rows || [];
      if (longRows.length < 3) {
        return { ok: true, source: 'daily_reports', text: `📈 明日营业额预测（${targetStore}）：样本不足（近${lookbackDays}天有效样本少于3天，近60天也不足3天），暂无法给出可信预测。` };
      }
      const lf = scoredForecast(longRows, 'day_revenue');
      const longPred = lf.pred;
      const longMin = lf.min;
      const longMax = lf.max;
      return {
        ok: true,
        source: 'sales_raw',
        text: `📈 明日营业额预测（${targetStore}）\n- 预测日期：${tomorrowText}（${'日一二三四五六'[tomorrowDow]}）\n- 预测值：¥${longPred.toFixed(0)}\n- 参考区间：¥${longMin.toFixed(0)} ~ ¥${longMax.toFixed(0)}\n- 同星期样本：${lf.sameDow}天（权重×4）\n- 依据样本：近60天销售明细按日汇总（${longRows.length}天有效样本）\n- 置信度：较低（近期样本不足，已启用长窗口兜底）\n> 算法：星期相似度加权+时间衰减，数据源：sales_raw`
      };
    }
    const sf = scoredForecast(salesRows, 'day_revenue');
    const pred = sf.pred;
    const minV = sf.min;
    const maxV = sf.max;
    return {
      ok: true,
      source: 'sales_raw',
      text: `📈 明日营业额预测（${targetStore}）\n- 预测日期：${tomorrowText}（${'日一二三四五六'[tomorrowDow]}）\n- 预测值：¥${pred.toFixed(0)}\n- 参考区间：¥${minV.toFixed(0)} ~ ¥${maxV.toFixed(0)}\n- 同星期样本：${sf.sameDow}天（权重×4）\n- 依据样本：近${lookbackDays}天销售明细按日汇总（${salesRows.length}天有效样本）\n> 算法：星期相似度加权+时间衰减，数据源：sales_raw`
    };
  } catch (e) {
    return { ok: false, source: 'daily_reports', text: `营业额预测查询失败：${e?.message || '未知错误'}` };
  }
}

async function execBiToolTableVisit(store, args = {}, originalQuery = '') {
  const targetStore = String(store || '').trim();
  if (!targetStore) return { ok: false, text: '当前账号未绑定门店，无法查询桌访记录。', source: 'table_visit_records' };

  const period = resolveToolPeriod(args, 7, originalQuery);
  try {
    const rows = await loadUnifiedTableVisitRowsByStore(targetStore, period.start, period.end);
    if (!rows.length) {
      return { ok: true, source: 'table_visit_records', text: `📋 ${period.label}桌访记录（${targetStore}）：暂无桌访数据。` };
    }
    // 维度1：不满意菜品（dissatisfaction_dish）
    const dishMap = {};
    for (const row of rows) {
      const items = String(row.dissatisfaction_dish || '').split(/[，,、]+/).map(x => x.trim()).filter(x => x && !/卤鹅/.test(x));
      for (const item of items) { dishMap[item] = (dishMap[item] || 0) + 1; }
    }
    const dishSorted = Object.entries(dishMap).sort((a, b) => b[1] - a[1]);
    // 维度2：顾客反馈/不满意原因（unsatisfied_items）— 这是桌访现场反馈，非大众点评差评
    const feedbackMap = {};
    const blockedFb = new Set(['无', '没有', '暂无', '不清楚', '未知', '其他', '']);
    for (const row of rows) {
      const fb = String(row.unsatisfied_items || '').trim();
      if (fb && !blockedFb.has(fb)) {
        fb.split(/[，,、]+/).map(x => x.trim()).filter(Boolean).forEach(x => { feedbackMap[x] = (feedbackMap[x] || 0) + 1; });
      }
    }
    const fbSorted = Object.entries(feedbackMap).sort((a, b) => b[1] - a[1]);

    const lines = [`📋 桌访反馈（${targetStore}·${period.label}）【注意：此数据来源于门店桌访巡台，非大众点评差评】`, `共${rows.length}条桌访记录`];
    if (fbSorted.length) {
      lines.push('', '🔔 桌访不满意反馈TOP：');
      fbSorted.slice(0, 8).forEach(([d, c], i) => lines.push(`${i + 1}. ${d}（${c}次）`));
    }
    if (dishSorted.length) {
      lines.push('', '🍽 桌访不满意菜品TOP：');
      dishSorted.slice(0, 8).forEach(([d, c], i) => lines.push(`${i + 1}. ${d}（${c}次）`));
    }
    if (!fbSorted.length && !dishSorted.length) {
      lines.push('', '该时段桌访未记录明确不满意内容。');
    }
    lines.push('', '> 数据源：table_visit_records（桌访巡台记录，非大众点评）');
    return { ok: true, source: 'table_visit_records', text: lines.join('\n') };
  } catch (e) {
    return { ok: false, source: 'table_visit_records', text: `桌访数据查询失败：${e?.message || '未知错误'}` };
  }
}

async function runBiFunctionTool(toolName, store, args = {}, originalQuery = '') {
  if (toolName === 'query_sales_ranking') return execBiToolSalesRanking(store, args, originalQuery);
  if (toolName === 'query_complaint_product_ranking') return execBiToolComplaintRanking(store, args, originalQuery);
  if (toolName === 'query_revenue_summary') return execBiToolRevenueSummary(store, args, originalQuery);
  if (toolName === 'query_revenue_forecast_next_day') return execBiToolRevenueForecastNextDay(store, args);
  if (toolName === 'query_table_visit') return execBiToolTableVisit(store, args, originalQuery);
  return { ok: false, source: 'unknown', text: `不支持的工具：${toolName}` };
}

function tryParseJsonObjectFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const direct = parseToolArgs(raw);
  if (direct && Object.keys(direct).length) return direct;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const parsed = parseToolArgs(m[0]);
  return parsed && Object.keys(parsed).length ? parsed : null;
}

function normalizeIntentPlan(rawPlan = {}) {
  const intent = String(rawPlan.intent || 'other').trim();
  const confidence = Math.max(0, Math.min(1, Number(rawPlan.confidence) || 0));
  const params = rawPlan.params && typeof rawPlan.params === 'object' ? rawPlan.params : {};
  return { intent, confidence, params };
}

async function buildBiIntentPlan(text, safeStore, conversationHistory = [], senderRole = '') {
  const historyHint = conversationHistory.length
    ? `\n\n最近对话记录（用于理解追问/上下文）：\n${conversationHistory.map(h => h.role === 'user' ? `用户: ${h.q} [工具:${h.tool||'无'}]` : `助手: ${h.a}`).join('\n')}`
    : '';
  const planner = await callLLM(
    [
      {
        role: 'system',
        content: `你是BI意图识别器。\n仅输出JSON，不要额外文字。\n候选intent：query_sales_ranking、query_complaint_product_ranking、query_revenue_summary、query_revenue_forecast_next_day、query_table_visit、other。\n输出格式：{"intent":"...","confidence":0-1,"params":{...}}\nparams仅允许：period_days,lookback_days,limit,sort_order,metric,biz_type。\n若用户问"最差/倒数/垫底"则sort_order=asc；问"最好/最多/TOP"则sort_order=desc。\n当前门店：${safeStore}（只用于理解上下文，最终权限以后端为准）。\n\n重要：用户可能在追问上一轮的结果（比如"给我10样""排前10呢""具体投诉什么"），请结合对话记录理解真实意图。若追问内容明显关联上一轮工具，复用同一intent并调整params（如limit/sort_order）。${historyHint}`
      },
      { role: 'user', content: String(text || '') }
    ],
    {
      model: getBiReasoningModel(),
      temperature: 0,
      max_tokens: 220,
      skipCache: true,
      role: senderRole,
      purpose: 'analysis'
    }
  );
  const parsed = tryParseJsonObjectFromText(planner?.content || '');
  if (!parsed) return { intent: 'other', confidence: 0, params: {} };
  return normalizeIntentPlan(parsed);
}

async function narrateBiToolResult(userText, toolText, store, senderRole = '') {
  const narr = await callLLM(
    [
      {
        role: 'system',
        content: `你是门店BI助手。请把工具查询结果转成简洁可执行的中文回答。\n严格要求：\n1) 只能使用"工具结果"中出现的事实，不得新增数字\n2) 结论先行，最多200字\n3) 保留关键口径（例如TOP/倒数、近N天）\n4) 若工具结果提示样本不足/暂无数据，直接如实说明，不要猜测\n5) 严格区分数据来源：桌访（table_visit_records）是门店服务员巡台记录，差评（bad_reviews）是大众点评/美团线上评价，不能混用"投诉""差评"等词描述桌访数据\n6) 桌访数据请用"桌访反馈""桌访不满意"等表述，差评数据才用"投诉""差评"等表述`
      },
      {
        role: 'user',
        content: `用户问题：${String(userText || '')}\n门店：${String(store || '')}\n工具结果：\n${String(toolText || '')}`
      }
    ],
    {
      model: getBiReasoningModel(),
      temperature: 0.1,
      max_tokens: 260,
      skipCache: true,
      role: senderRole,
      purpose: 'reasoning'
    }
  );
  const content = String(narr?.content || '').trim();
  return content || toolText;
}

async function tryHandleBiByFunctionCalling({ text, store, brand, senderRole, senderUsername }) {
  const userId = String(senderUsername || 'anon').trim();
  let safeStore = String(store || '').trim();
  const lastCtx = _biLastToolCtx.get(userId);
  const roleTier = getModelTier(senderRole);
  const allowedTools = new Set(getAvailableTools(senderRole));

  // HQ用户常见场景：store=总部，优先继承上一轮工具上下文门店
  if ((!safeStore || safeStore === '总部') && lastCtx?.store) {
    safeStore = String(lastCtx.store || '').trim();
  }
  // 品牌关键词补全门店
  if (!safeStore || safeStore === '总部') {
    try {
      if (/马己仙/.test(String(text || ''))) {
        const r = await pool().query(`SELECT store FROM sales_raw WHERE store LIKE '%马己仙%' GROUP BY store ORDER BY COUNT(*) DESC LIMIT 1`);
        safeStore = String(r.rows?.[0]?.store || '').trim() || safeStore;
      } else if (/洪潮/.test(String(text || ''))) {
        const r = await pool().query(`SELECT store FROM sales_raw WHERE store LIKE '%洪潮%' GROUP BY store ORDER BY COUNT(*) DESC LIMIT 1`);
        safeStore = String(r.rows?.[0]?.store || '').trim() || safeStore;
      }
    } catch (e) {}
  }
  if (!safeStore || safeStore === '总部') { console.log('[bi-fc] skip: no valid store'); return null; }

  // 多轮追问强化：复用上一轮工具和参数，解决“其他呢/最差的”错判
  const q = String(text || '').trim();
  const isFollowup = /(其他呢|还有呢|再来|继续|更多|再给我|我要最差|最差的|倒数|垫底|最好|前十|前10|top10|top 10)/i.test(q);
  if (isFollowup && lastCtx?.tool) {
    if (!allowedTools.has(lastCtx.tool) || !isToolAllowed(senderRole, lastCtx.tool)) {
      return {
        response: '当前角色暂不支持该数据分析工具，请联系管理员开通对应权限。',
        meta: { permissionDenied: true, tool: lastCtx.tool, role: senderRole, store: safeStore }
      };
    }
    const args = { ...(lastCtx.args || {}) };
    if (/(最差|倒数|垫底)/.test(q)) args.sort_order = 'asc';
    if (/(最好|前十|前10|top10|top 10)/i.test(q)) args.sort_order = 'desc';
    if (/(其他呢|还有呢|再来|继续|更多|再给我)/.test(q)) args.limit = clampInt(Number(args.limit || 10) + 5, 1, 20, 20);

    const executed = await runBiFunctionTool(lastCtx.tool, safeStore, args, text);
    if (executed?.text && !/暂无.*数据|无法查询|未绑定门店/.test(String(executed.text || ''))) {
      const narrated = await narrateBiToolResult(text, executed.text, safeStore, senderRole);
      pushBiConversationTurn(userId, text, narrated, lastCtx.tool);
      _biLastToolCtx.set(userId, { tool: lastCtx.tool, args, store: safeStore, ts: Date.now() });
      return {
        response: narrated,
        meta: {
          source: executed.source,
          tool: lastCtx.tool,
          args,
          intentPlan: { intent: lastCtx.tool, confidence: 1, params: args },
          grounded: !!executed.ok,
          followup: true,
          store: safeStore,
          brand,
          role: senderRole
        }
      };
    }
  }

  const convHistory = getBiConversationHistory(userId);
  console.log('[bi-fc] start intent planning for:', JSON.stringify(text).slice(0, 80), 'store:', safeStore, 'historyTurns:', convHistory.length / 2);
  const intentPlan = await buildBiIntentPlan(text, safeStore, convHistory, senderRole);
  // 文本启发式兜底：避免“最差/倒数”被LLM误判成TOP查询
  if (intentPlan?.params && /(最差|倒数|垫底|最低)/.test(q)) intentPlan.params.sort_order = 'asc';
  if (intentPlan?.params && /(最好|最高|top|前十|前10)/i.test(q)) intentPlan.params.sort_order = 'desc';
  if (intentPlan?.params && /(其他呢|还有呢|再来|继续|更多|再给我)/.test(q) && !intentPlan.params.limit) {
    intentPlan.params.limit = 15;
  }
  console.log('[bi-fc] intentPlan:', JSON.stringify(intentPlan));
  if (!intentPlan?.intent || intentPlan.intent === 'other' || intentPlan.confidence < 0.55) {
    console.log('[bi-fc] skip: intent not actionable');
    return null;
  }

  const intentToolMap = {
    query_sales_ranking: 'query_sales_ranking',
    query_complaint_product_ranking: 'query_complaint_product_ranking',
    query_revenue_summary: 'query_revenue_summary',
    query_revenue_forecast_next_day: 'query_revenue_forecast_next_day',
    query_table_visit: 'query_table_visit'
  };
  const preferredTool = intentToolMap[intentPlan.intent] || '';
  if (!preferredTool) { console.log('[bi-fc] skip: no tool for intent', intentPlan.intent); return null; }

  if (!allowedTools.has(preferredTool) || !isToolAllowed(senderRole, preferredTool)) {
    return {
      response: '当前角色暂无权限调用该分析工具，建议联系管理员开通后重试。',
      meta: {
        permissionDenied: true,
        requestedTool: preferredTool,
        role: senderRole,
        store: safeStore,
        intentPlan
      }
    };
  }

  const budgetExceeded = isTierBudgetExceeded(roleTier);
  let name = preferredTool;
  let args = { ...(intentPlan.params || {}) };
  if (!budgetExceeded) {
    const toolPlanner = await callLLM(
      [
        {
          role: 'system',
          content: `你是BI工具参数器。必须调用工具且只返回工具调用。\n当前用户门店：${safeStore}（该门店是硬约束，不得跨店）。\n已识别意图：${intentPlan.intent}（置信度${intentPlan.confidence.toFixed(2)}）。\n请为指定工具补齐最合理参数。`
        },
        { role: 'user', content: String(text || '') }
      ],
      {
        model: getBiReasoningModel(),
        temperature: 0,
        max_tokens: 300,
        tools: BI_FUNCTION_TOOLS,
        tool_choice: { type: 'function', function: { name: preferredTool } },
        skipCache: true,
        role: senderRole,
        purpose: 'analysis'
      }
    );

    const toolCalls = Array.isArray(toolPlanner?.message?.tool_calls) ? toolPlanner.message.tool_calls : [];
    console.log('[bi-fc] toolPlanner ok:', toolPlanner?.ok, 'toolCalls:', toolCalls.length, 'content:', String(toolPlanner?.content || '').slice(0, 80));
    const call = toolCalls[0] || null;
    name = String(call?.function?.name || preferredTool).trim() || preferredTool;
    const llmArgs = parseToolArgs(call?.function?.arguments);
    args = { ...(intentPlan.params || {}), ...(llmArgs || {}) };
  }

  if (!name) { console.log('[bi-fc] skip: no tool name resolved'); return null; }
  console.log('[bi-fc] executing tool:', name, 'args:', JSON.stringify(args));
  const executed = await runBiFunctionTool(name, safeStore, args, text);
  console.log('[bi-fc] executed ok:', executed?.ok, 'source:', executed?.source, 'textLen:', String(executed?.text || '').length);
  if (!executed?.text) { console.log('[bi-fc] skip: empty tool result'); return null; }
  if (/暂无.*数据|无法查询|未绑定门店/.test(String(executed.text || ''))) {
    console.log('[bi-fc] skip: tool returned no-data, fallthrough to deterministic path');
    return null;
  }

  const narrated = await narrateBiToolResult(text, executed.text, safeStore, senderRole);
  console.log('[bi-fc] narrated len:', narrated?.length);

  pushBiConversationTurn(userId, text, narrated, name);
  _biLastToolCtx.set(userId, { tool: name, args, store: safeStore, ts: Date.now() });

  return {
    response: narrated,
    meta: {
      source: executed.source,
      tool: name,
      args,
      intentPlan,
      grounded: !!executed.ok,
      budgetExceeded,
      store: safeStore,
      brand,
      role: senderRole
    }
  };
}

function resolveDateRangeFromQuestion(text, dd = 7) {
  const q = String(text||'').trim();
  const now = new Date(), today = new Date(now.getFullYear(),now.getMonth(),now.getDate()), ms = 86400000;
  if (/今[天日]/.test(q)) return {label:'今日',start:formatDate(today),end:formatDate(today)};
  if (/昨[天日]/.test(q)) { const y=new Date(today-ms); return {label:'昨日',start:formatDate(y),end:formatDate(y)}; }
  if (/前[天日]/.test(q)) { const d=new Date(today-2*ms); return {label:'前天',start:formatDate(d),end:formatDate(d)}; }
  if (/上周/.test(q)) { const dow=today.getDay()||7; const m=new Date(today-(dow+6)*ms); return {label:'上周',start:formatDate(m),end:formatDate(new Date(+m+6*ms))}; }
  if (/本周/.test(q)) { const dow=today.getDay()||7; return {label:'本周',start:formatDate(new Date(today-(dow-1)*ms)),end:formatDate(today)}; }
  if (/上[个]?月/.test(q)) { const f=new Date(now.getFullYear(),now.getMonth(),1),l=new Date(f-ms),s=new Date(l.getFullYear(),l.getMonth(),1); return {label:'上月',start:formatDate(s),end:formatDate(l)}; }
  if (/本月/.test(q)) return {label:'本月',start:formatDate(new Date(now.getFullYear(),now.getMonth(),1)),end:formatDate(today)};
  const nm = q.match(/近\s*(\d+)\s*天/);
  if (nm) { const n=parseInt(nm[1],10)||dd; return {label:`近${n}天`,start:formatDate(new Date(today-(n-1)*ms)),end:formatDate(today)}; }
  return {label:`近${dd}天`,start:formatDate(new Date(today-(dd-1)*ms)),end:formatDate(today)};
}

function isDataBackedReply(d) {
  return !!(d && (
    d.dataBacked === true ||
    d.deterministic === true ||
    d.grounded === true ||
    d.functionCalling === true ||
    !!d.source
  ));
}

function isFactLikeQuestion(text) {
  const q = String(text || '').trim();
  if (!q) return false;
  const hasFactTopic = /(营业额|营收|生意|经营情况|差评|桌访|开档|收档|例会|原料|kpi|考核指标|评分|门店|菜品|员工|姓名)/i.test(q);
  const hasQuestionPattern = /(多少|怎么样|如何|情况|对比|趋势|排名|top|为什么|分析|异常|有没有)/i.test(q);
  return hasFactTopic && hasQuestionPattern;
}

async function buildBiDeterministicDataSourceCoverageReply(text) {
  const q = String(text || '').trim();
  if (!/(数据源|数据范围|能查什么|知道什么|覆盖|哪些表|可用数据)/.test(q)) return '';

  const sourceDefs = [
    { key: 'table_visit_records', label: '桌访记录（系统入库）', sql: `SELECT COUNT(*)::int AS c, MAX(date)::text AS latest FROM table_visit_records` },
    { key: 'daily_reports', label: '营业日报（系统）', sql: `SELECT COUNT(*)::int AS c, MAX(date)::text AS latest FROM daily_reports` },
    { key: 'bad_reviews', label: '差评报告（同步）', sql: `SELECT COUNT(*)::int AS c, MAX(created_at)::text AS latest FROM agent_messages WHERE content_type='negative_review'` },
    { key: 'opening_reports_bitable', label: '开档报告（同步）', sql: `SELECT COUNT(DISTINCT record_id)::int AS c, MAX(created_at)::text AS latest FROM agent_messages WHERE content_type='opening_report'` },
    { key: 'closing_reports_bitable', label: '收档报告（同步）', sql: `SELECT COUNT(DISTINCT record_id)::int AS c, MAX(created_at)::text AS latest FROM agent_messages WHERE content_type='closing_report'` },
    { key: 'meeting_reports_bitable', label: '例会报告（同步）', sql: `SELECT COUNT(DISTINCT record_id)::int AS c, MAX(created_at)::text AS latest FROM agent_messages WHERE content_type='meeting_report'` },
    { key: 'material_majixian_bitable', label: '马己仙原料收货（同步）', sql: `SELECT COUNT(DISTINCT record_id)::int AS c, MAX(created_at)::text AS latest FROM agent_messages WHERE content_type='material_report' AND lower(coalesce(agent_data->>'brand','')) LIKE '%maji%'` },
    { key: 'material_hongchao_bitable', label: '洪潮原料收货（同步）', sql: `SELECT COUNT(DISTINCT record_id)::int AS c, MAX(created_at)::text AS latest FROM agent_messages WHERE content_type='material_report' AND lower(coalesce(agent_data->>'brand','')) LIKE '%hong%'` }
  ];

  const lines = [];
  for (const s of sourceDefs) {
    if (!isBiSourceEnabled(s.key)) {
      lines.push(`- ${s.label}：已禁用`);
      continue;
    }
    try {
      const r = await pool().query(s.sql);
      const c = Number(r.rows?.[0]?.c || 0);
      const latest = String(r.rows?.[0]?.latest || '').trim() || '-';
      lines.push(`- ${s.label}：${c}条（latest=${latest}）`);
    } catch (_e) {
      lines.push(`- ${s.label}：查询失败`);
    }
  }

  return `当前 BI 可用数据源覆盖如下：\n${lines.join('\n')}\n\n说明：事实问答仅使用以上可用且可查询的数据源；缺失时将固定拒答。`;
}

function resolveBiRelevantSourceKeys(text) {
  const q = String(text || '').trim();
  const keys = new Set();
  if (/(桌访|桌巡|巡台|巡桌|不满意.*菜|菜品.*不满意|最不满意|出品.*不满意)/.test(q)) {
    keys.add('table_visit_records');
    keys.add('table_visit_bitable');
  }
  if (/(差评|点评|评论|客诉)/.test(q)) {
    keys.add('bad_reviews');
  }
  if (/(开档|开市)/.test(q)) {
    keys.add('opening_reports_bitable');
  }
  if (/(收档|收市|闭市)/.test(q)) {
    keys.add('closing_reports_bitable');
  }
  if (/(例会|会议)/.test(q)) {
    keys.add('meeting_reports_bitable');
  }
  if (/(原料|收货)/.test(q)) {
    keys.add('material_majixian_bitable');
    keys.add('material_hongchao_bitable');
  }
  if (/(营业额|营收|收入|对账|毛利|损耗|成本|人效|KPI|kpi)/.test(q)) {
    keys.add('daily_reports');
  }
  if (/(堂食|外卖|销售明细|时段.*销|午市|晚市|热销|畅销|备货|菜品.*销量|点单)/.test(q)) {
    keys.add('sales_raw');
    keys.add('inventory_forecast');
  }
  if (keys.size === 0 && isFactLikeQuestion(q)) {
    keys.add('daily_reports');
    keys.add('table_visit_records');
    keys.add('bad_reviews');
  }
  return Array.from(keys);
}

async function buildBiFactSourceAudit(store, text) {
  const keyDefs = {
    table_visit_records: {
      label: '桌访记录（系统入库）',
      sql: `SELECT COUNT(*)::int AS c, MAX(date)::text AS latest FROM table_visit_records WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) = $1`,
      params: [normalizeStoreKey(store)]
    },
    table_visit_bitable: {
      label: '桌访表（飞书）',
      sql: `SELECT COUNT(DISTINCT record_id)::int AS c, MAX(created_at)::text AS latest FROM agent_messages WHERE content_type='table_visit' AND lower(regexp_replace(coalesce(agent_data->>'store', agent_data#>>'{fields,store}', ''), '\\s+', '', 'g')) = $1`,
      params: [normalizeStoreKey(store)]
    },
    bad_reviews: {
      label: '差评报告（同步）',
      sql: `SELECT COUNT(*)::int AS c, MAX(created_at)::text AS latest FROM agent_messages WHERE content_type='negative_review' AND lower(regexp_replace(coalesce(agent_data->>'store', ''), '\\s+', '', 'g')) = $1`,
      params: [normalizeStoreKey(store)]
    },
    opening_reports_bitable: {
      label: '开档报告（同步）',
      sql: `SELECT COUNT(DISTINCT record_id)::int AS c, MAX(created_at)::text AS latest FROM agent_messages WHERE content_type='opening_report' AND lower(regexp_replace(coalesce(agent_data#>>'{fields,store}', agent_data->>'store', ''), '\\s+', '', 'g')) = $1`,
      params: [normalizeStoreKey(store)]
    },
    closing_reports_bitable: {
      label: '收档报告（同步）',
      sql: `SELECT COUNT(DISTINCT record_id)::int AS c, MAX(created_at)::text AS latest FROM agent_messages WHERE content_type='closing_report' AND lower(regexp_replace(coalesce(agent_data#>>'{fields,store}', agent_data->>'store', ''), '\\s+', '', 'g')) = $1`,
      params: [normalizeStoreKey(store)]
    },
    meeting_reports_bitable: {
      label: '例会报告（同步）',
      sql: `SELECT COUNT(DISTINCT record_id)::int AS c, MAX(created_at)::text AS latest FROM agent_messages WHERE content_type='meeting_report' AND lower(regexp_replace(coalesce(agent_data#>>'{fields,store}', agent_data->>'store', ''), '\\s+', '', 'g')) = $1`,
      params: [normalizeStoreKey(store)]
    },
    material_majixian_bitable: {
      label: '马己仙原料收货（同步）',
      sql: `SELECT COUNT(DISTINCT record_id)::int AS c, MAX(created_at)::text AS latest FROM agent_messages WHERE content_type='material_report' AND lower(regexp_replace(coalesce(agent_data#>>'{fields,store}', agent_data->>'store', ''), '\\s+', '', 'g')) = $1 AND lower(coalesce(agent_data->>'brand','')) LIKE '%maji%'`,
      params: [normalizeStoreKey(store)]
    },
    material_hongchao_bitable: {
      label: '洪潮原料收货（同步）',
      sql: `SELECT COUNT(DISTINCT record_id)::int AS c, MAX(created_at)::text AS latest FROM agent_messages WHERE content_type='material_report' AND lower(regexp_replace(coalesce(agent_data#>>'{fields,store}', agent_data->>'store', ''), '\\s+', '', 'g')) = $1 AND lower(coalesce(agent_data->>'brand','')) LIKE '%hong%'`,
      params: [normalizeStoreKey(store)]
    },
    daily_reports: {
      label: '营业日报（系统）',
      sql: `SELECT COUNT(*)::int AS c, MAX(date)::text AS latest FROM daily_reports WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) = $1`,
      params: [normalizeStoreKey(store)]
    },
    sales_raw: {
      label: '销售明细（sales_raw）',
      sql: `SELECT COUNT(*)::int AS c, MAX(date)::text AS latest FROM sales_raw WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) = $1`,
      params: [normalizeStoreKey(store)]
    }
  };

  const relevant = resolveBiRelevantSourceKeys(text);
  const rows = [];
  for (const key of relevant) {
    const def = keyDefs[key];
    if (!def) continue;
    if (!isBiSourceEnabled(key)) {
      rows.push({ key, label: def.label, status: 'disabled', count: 0, latest: '-' });
      continue;
    }
    try {
      const r = await pool().query(def.sql, def.params);
      const c = Number(r.rows?.[0]?.c || 0);
      const latest = String(r.rows?.[0]?.latest || '').trim() || '-';
      rows.push({ key, label: def.label, status: c > 0 ? 'ok' : 'empty', count: c, latest });
    } catch (_e) {
      rows.push({ key, label: def.label, status: 'error', count: 0, latest: '-' });
    }
  }
  return rows;
}

function buildBiSourceAuditText(auditRows = []) {
  if (!Array.isArray(auditRows) || auditRows.length === 0) return '';
  const lines = auditRows.map((x) => {
    const statusText = x.status === 'ok'
      ? '可用'
      : x.status === 'empty'
        ? '空样本'
        : x.status === 'disabled'
          ? '已禁用'
          : '查询失败';
    return `- ${x.label}：${statusText}（count=${Number(x.count || 0)}, latest=${x.latest || '-'})`;
  });
  return lines.join('\n');
}

function buildFeishuCardFromAgentReply(route, resp) {
  if (!resp) return null;
  const t = {data_auditor:'小年',ops_supervisor:'小年',master:'小年'}[route] || '小年';
  const c = {data_auditor:'blue',ops_supervisor:'green',master:'indigo'}[route] || 'blue';
  return {config:{wide_screen_mode:true},header:{title:{content:t,tag:'plain_text'},template:c},elements:[{tag:'div',text:{content:String(resp),tag:'lark_md'}}]};
}

function buildKpiRadarAlertJson(issue) {
  return JSON.stringify({type:'kpi_radar',category:issue?.category||'',store:issue?.store||'',severity:issue?.severity||'medium',title:issue?.title||'',timestamp:new Date().toISOString()});
}

async function buildBiDeterministicTableVisitReply(store, text) {
  const q = String(text||'').trim(), s = String(store||'').trim();
  if (!s) return '';
  if (!/(桌访|桌巡|巡台|不满意.*菜|菜品.*不满意|出品.*不满意|最不满意)/.test(q)) return '';
  if (!isBiSourceEnabled('table_visit_records')) return '';
  const p = resolveDateRangeFromQuestion(q, 7);
  try {
    const r = await pool().query(
      `SELECT dissatisfaction_dish, unsatisfied_items, date FROM table_visit_records WHERE lower(regexp_replace(coalesce(store,''),'\\s+','','g'))=$1 AND date>=$2 AND date<=$3 ORDER BY date DESC LIMIT 100`,
      [normalizeStoreKey(s), p.start, p.end]
    );
    const rows = r.rows||[];
    if (!rows.length) return `📋 ${p.label}桌访记录（${s}）：暂无桌访数据。`;
    // 维度1：不满意菜品
    const dishMap = {};
    for (const row of rows) {
      const items = String(row.dissatisfaction_dish||'').split(/[，,、]+/).map(x=>x.trim()).filter(x=>x&&!/卤鹅/.test(x));
      for (const d of items) { dishMap[d] = (dishMap[d]||0) + 1; }
    }
    const dishSorted = Object.entries(dishMap).sort((a,b)=>b[1]-a[1]);
    // 维度2：桌访反馈原因（unsatisfied_items）
    const fbMap = {};
    const blockedFb = new Set(['无','没有','暂无','不清楚','未知','其他','']);
    for (const row of rows) {
      const fb = String(row.unsatisfied_items||'').trim();
      if (fb && !blockedFb.has(fb)) {
        fb.split(/[，,、]+/).map(x=>x.trim()).filter(Boolean).forEach(x => { fbMap[x] = (fbMap[x]||0) + 1; });
      }
    }
    const fbSorted = Object.entries(fbMap).sort((a,b)=>b[1]-a[1]);
    const lines = [`📋 桌访反馈（${s}·${p.label}）【数据来源：桌访巡台记录，非大众点评】`, `共${rows.length}条桌访记录`];
    if (fbSorted.length) {
      lines.push('', '🔔 桌访不满意反馈TOP：');
      fbSorted.slice(0,8).forEach(([d,c],i) => lines.push(`${i+1}. ${d}（${c}次）`));
    }
    if (dishSorted.length) {
      lines.push('', '🍽 桌访不满意菜品TOP：');
      dishSorted.slice(0,8).forEach(([d,c],i) => lines.push(`${i+1}. ${d}（${c}次）`));
    }
    if (!fbSorted.length && !dishSorted.length) {
      lines.push('', '该时段桌访未记录明确不满意内容。');
    }
    return lines.join('\n');
  } catch(e) { return `桌访数据查询失败：${e?.message||'未知错误'}`; }
}

async function buildBiDeterministicOpsReportCountReply(store, text) {
  const q = String(text || '').trim();
  const targetStore = String(store || '').trim();
  if (!targetStore) return '';
  if (!/(开档|收档|例会|原料)/.test(q)) return '';
  if (!/(多少|几次|几条|总数|次数|记录数|统计|一共|有没有|是否|吗)/.test(q)) return '';

  const period = resolveDateRangeFromQuestion(q, 7);
  const periodLabel = period.label;
  const start = period.start;
  const end = period.end;
  const rows = await loadUnifiedTableVisitRowsByStore(targetStore, start, end);
  if (!rows.length) {
    return `${periodLabel}桌访数据（${targetStore}）：0条记录。该时间段暂无桌访数据入库。`;
  }

  // 统计不满意菜品
  const dishTop = new Map();
  rows.forEach((x) => {
    extractTableVisitDishes(x).forEach((k) => dishTop.set(k, (dishTop.get(k) || 0) + 1));
  });
  const dishTopList = Array.from(dishTop.entries()).sort((a, b) => b[1] - a[1]);
  const topDish = dishTopList[0] || null;

  // 统计顾客反馈/满意原因（unsatisfied_items 实际存的是满意或不满意原因）
  const feedbackTop = new Map();
  const blockedFb = new Set(['无', '没有', '暂无', '不清楚', '未知', '其他', '']);
  rows.forEach((x) => {
    const reason = String(x?.unsatisfied_items || '').trim();
    if (reason && !blockedFb.has(reason)) {
      feedbackTop.set(reason, (feedbackTop.get(reason) || 0) + 1);
    }
  });
  const feedbackList = Array.from(feedbackTop.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const feedbackText = feedbackList.map(([k, v]) => `「${k}」(${v}次)`).join('、') || '无';
  const feedbackCount = rows.filter(x => { const r = String(x?.unsatisfied_items || '').trim(); return r && !blockedFb.has(r); }).length;

  // 识别负面反馈（排除明显正面内容后，匹配负面关键词）
  const positiveOnly = /^(.*好吃.*|.*满意.*|.*不错.*|.*喜欢.*|.*很好.*|.*挺好.*|.*可以的|.*味道好.*)$/;
  const negativePattern = /太[咸淡冷油辣热硬]|有点[咸淡冷硬腥慢小挤]|不满意|不好吃|不新鲜|不够|偏[咸淡]|等[很太]久|等了[很太]久|上菜[有稍]?[点微]?慢|不[满熟行]|肿了|太老|没有肉感|不是很满意|该[咸淡]的不[咸淡]/;
  const negFeedbackTop = new Map();
  rows.forEach((x) => {
    const reason = String(x?.unsatisfied_items || '').trim();
    if (reason && !blockedFb.has(reason) && negativePattern.test(reason) && !positiveOnly.test(reason)) {
      negFeedbackTop.set(reason, (negFeedbackTop.get(reason) || 0) + 1);
    }
  });
  const negList = Array.from(negFeedbackTop.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const negCount = negList.reduce((s, [, v]) => s + v, 0);
  const negText = negList.map(([k, v]) => `「${k}」(${v}次)`).join('、');

  const dissatisfactionIntent = /(最不满意|哪里不满意|哪些不满意|不满意点|不满意.*菜|菜品.*不满意|出品.*不满意)/.test(q);
  if (dissatisfactionIntent) {
    const lines = [`📋 ${periodLabel}桌访不满意反馈（${targetStore}）`];
    lines.push(`样本：${rows.length}条桌访`);
    if (negList.length) {
      lines.push(`\n⚠️ 负面反馈（${negCount}条）：`);
      negList.forEach(([k, v]) => lines.push(`  · ${k}（${v}次）`));
    }
    if (topDish) {
      lines.push(`\n🍽 不满意菜品：`);
      dishTopList.slice(0, 5).forEach(([k, v]) => lines.push(`  · ${k}（${v}次）`));
    }
    if (!negList.length && !topDish) {
      lines.push(`\n该时段顾客未反馈明确不满意内容。`);
    }
    return lines.join('\n');
  }

  if (/(多少|几条|总数|记录|样本|一共)/.test(q)) {
    return `${periodLabel}桌访数据（${targetStore}）\n- 桌访记录：${rows.length}条\n- 含反馈记录：${feedbackCount}条`;
  }

  // 默认兜底：简洁统计摘要
  const lines = [`📋 ${periodLabel}桌访概况（${targetStore}）`];
  lines.push(`- 桌访记录：${rows.length}条`);
  if (negList.length) lines.push(`- 负面反馈：${negList.slice(0, 3).map(([k, v]) => `${k}(${v}次)`).join('、')}`);
  if (topDish) lines.push(`- 不满意菜品：${dishTopList.slice(0, 3).map(([k, v]) => `${k}(${v}次)`).join('、')}`);
  return lines.join('\n');
}

// BI确定性回复：收档报告（得分、合格率）
async function buildBiDeterministicClosingReportReply(store, text) {
  const q = String(text || '').trim();
  const targetStore = String(store || '').trim();
  if (!targetStore) return '';
  if (!/(收档|收市|闭档|清洁|卫生|档口.*得分|得分.*档口|平均.*得分|得分.*平均)/.test(q)) return '';
  const period = resolveDateRangeFromQuestion(q, 7);
  const tableId = String(BITABLE_CONFIGS?.closing_reports?.tableId || '').trim();
  if (!tableId) return `收档报告数据源未配置，无法查询。`;
  try {
    const r = await pool().query(
      `SELECT fields FROM feishu_generic_records WHERE table_id = $1 ORDER BY updated_at DESC LIMIT 3000`,
      [tableId]
    );
    const all = (r.rows || []).map(row => row.fields && typeof row.fields === 'object' ? row.fields : {});
    const matched = all.filter(f => {
      const s = String(f['门店'] || f['所属门店'] || '').trim();
      return isLikelySameStore(s, targetStore);
    });
    const inRange = matched.filter(f => {
      const d = normalizeBitableDateValue(f['提交时间'] || f['日期'], null);
      return d && inDateRangeInclusive(d, period.start, period.end);
    });
    if (!inRange.length) {
      return `${period.label}收档报告（${targetStore}）：0条记录。该时间段暂无收档报告入库。`;
    }
    const scores = inRange.map(f => {
      const s = extractBitableFieldText(f['档口收档平均得分']);
      return parseFloat(s);
    }).filter(n => !isNaN(n));
    const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '无';
    const passCount = inRange.filter(f => /合格|通过|是/.test(extractBitableFieldText(f['是否合格']))).length;
    const passRate = inRange.length ? ((passCount / inRange.length) * 100).toFixed(0) + '%' : '无';
    const lines = [
      `${period.label}收档报告（${targetStore}）`,
      `- 收档记录：${inRange.length}条`,
      `- 档口平均得分：${avgScore}`,
      `- 合格率：${passRate}（${passCount}/${inRange.length}）`,
    ];
    if (scores.length) {
      lines.push(`- 最高分：${Math.max(...scores)} / 最低分：${Math.min(...scores)}`);
    }
    return lines.join('\n');
  } catch (e) {
    return `收档报告查询失败：${e?.message || '未知错误'}`;
  }
}

// BI确定性回复：开档报告
async function buildBiDeterministicOpeningReportReply(store, text) {
  const q = String(text || '').trim();
  const targetStore = String(store || '').trim();
  if (!targetStore) return '';
  if (!/(开档|开市|备餐|开档.*记录|开档.*报告)/.test(q)) return '';
  const period = resolveDateRangeFromQuestion(q, 7);
  const tableId = String(BITABLE_CONFIGS?.opening_reports?.tableId || '').trim();
  if (!tableId) return `开档报告数据源未配置，无法查询。`;
  try {
    const r = await pool().query(
      `SELECT fields FROM feishu_generic_records WHERE table_id = $1 ORDER BY updated_at DESC LIMIT 3000`,
      [tableId]
    );
    const all = (r.rows || []).map(row => row.fields && typeof row.fields === 'object' ? row.fields : {});
    const matched = all.filter(f => {
      const s = String(f['门店'] || f['所属门店'] || '').trim();
      return isLikelySameStore(s, targetStore);
    });
    const inRange = matched.filter(f => {
      const d = normalizeBitableDateValue(f['记录日期'] || f['提交时间'] || f['日期'], null);
      return d && inDateRangeInclusive(d, period.start, period.end);
    });
    if (!inRange.length) {
      return `${period.label}开档报告（${targetStore}）：0条记录。该时间段暂无开档报告入库。`;
    }
    const stationTop = new Map();
    inRange.forEach(f => {
      const station = extractBitableFieldText(f['岗位'] || f['档口']);
      if (station) stationTop.set(station, (stationTop.get(station) || 0) + 1);
    });
    const stationText = Array.from(stationTop.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}(${v})`).join('、') || '无';
    const mealTop = new Map();
    inRange.forEach(f => {
      const meal = extractBitableFieldText(f['饭市']);
      if (meal) mealTop.set(meal, (mealTop.get(meal) || 0) + 1);
    });
    const mealText = Array.from(mealTop.entries()).map(([k, v]) => `${k}(${v})`).join('、') || '无';
    return [`${period.label}开档报告（${targetStore}）`, `- 开档记录：${inRange.length}条`, `- 岗位分布：${stationText}`, `- 饭市分布：${mealText}`].join('\n');
  } catch (e) {
    return `开档报告查询失败：${e?.message || '未知错误'}`;
  }
}

// BI确定性回复：原料收货日报（异常）
async function buildBiDeterministicMaterialReportReply(store, text) {
  const q = String(text || '').trim();
  const targetStore = String(store || '').trim();
  if (!targetStore) return '';
  if (!/(原料|收货|食材|进货|供应商|原材料)/.test(q)) return '';
  const period = resolveDateRangeFromQuestion(q, 7);
  const tableIds = [
    BITABLE_CONFIGS?.material_hongchao?.tableId,
    BITABLE_CONFIGS?.material_majixian?.tableId
  ].filter(Boolean);
  if (!tableIds.length) return `原料收货日报数据源未配置，无法查询。`;
  try {
    const r = await pool().query(
      `SELECT fields FROM feishu_generic_records WHERE table_id = ANY($1) ORDER BY updated_at DESC LIMIT 3000`,
      [tableIds]
    );
    const all = (r.rows || []).map(row => row.fields && typeof row.fields === 'object' ? row.fields : {});
    const matched = all.filter(f => {
      const s = String(f['所属门店'] || f['门店'] || '').trim();
      return isLikelySameStore(s, targetStore);
    });
    const inRange = matched.filter(f => {
      const d = normalizeBitableDateValue(f['收货日期'] || f['日期'], null);
      return d && inDateRangeInclusive(d, period.start, period.end);
    });
    if (!inRange.length) {
      return `${period.label}原料收货日报（${targetStore}）：0条记录。该时间段暂无原料异常数据入库。`;
    }
    const hasIssue = inRange.filter(f => {
      const feedback = extractBitableFieldText(f['今日异常反馈'] || f['今天原料情况']);
      return feedback && !/正常|无|没有/.test(feedback);
    });
    const materialTop = new Map();
    hasIssue.forEach(f => {
      const name = extractBitableFieldText(f['异常原料名称']);
      if (name) materialTop.set(name, (materialTop.get(name) || 0) + 1);
    });
    const matText = Array.from(materialTop.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}(${v}次)`).join('、') || '无';
    const severityTop = new Map();
    hasIssue.forEach(f => {
      const sev = extractBitableFieldText(f['严重情况']);
      if (sev) severityTop.set(sev, (severityTop.get(sev) || 0) + 1);
    });
    const sevText = Array.from(severityTop.entries()).map(([k, v]) => `${k}(${v})`).join('、') || '无';
    const lines = [
      `${period.label}原料收货日报（${targetStore}）`,
      `- 收货记录：${inRange.length}条`,
      `- 异常记录：${hasIssue.length}条`,
      `- 异常原料Top：${matText}`,
      `- 严重程度：${sevText}`
    ];
    return lines.join('\n');
  } catch (e) {
    return `原料收货日报查询失败：${e?.message || '未知错误'}`;
  }
}

// BI确定性回复：例会报告统计
async function buildBiDeterministicMeetingReportReply(store, text) {
  const q = String(text || '').trim();
  const targetStore = String(store || '').trim();
  if (!targetStore) return '';
  if (!/(例会|早会|班会|会议|开会)/.test(q)) return '';
  const period = resolveDateRangeFromQuestion(q, 30);
  const tableId = String(BITABLE_CONFIGS?.meeting_reports?.tableId || '').trim();
  if (!tableId) return `例会报告数据源未配置，无法查询。`;
  try {
    const r = await pool().query(
      `SELECT fields FROM feishu_generic_records WHERE table_id = $1 ORDER BY updated_at DESC LIMIT 500`,
      [tableId]
    );
    const rows = (r.rows || []).filter(row => {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const rowStore = extractBitableFieldText(f['所属门店'] || f['门店']);
      return isLikelySameStore(rowStore, targetStore);
    });
    if (!rows.length) return `📊 ${period.label}例会数据（${targetStore}）：暂无例会记录入库。`;
    const scores = rows.map(row => parseFloat(extractBitableFieldText(row.fields['得分']))).filter(n => !isNaN(n));
    const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '-';
    const hosts = new Map();
    rows.forEach(row => {
      const h = extractBitableFieldText(row.fields['主持人']);
      if (h) hosts.set(h, (hosts.get(h) || 0) + 1);
    });
    const absentees = new Map();
    rows.forEach(row => {
      const abs = extractBitableFieldText(row.fields['缺席人员姓名']);
      if (abs && abs !== '无') abs.split(/[,，、]/).forEach(n => { n = n.trim(); if (n) absentees.set(n, (absentees.get(n) || 0) + 1); });
    });
    const lines = [`📊 例会数据（${targetStore}）`];
    lines.push(`- 例会记录：${rows.length}次`);
    if (avgScore !== '-') lines.push(`- 平均得分：${avgScore}分`);
    if (hosts.size) lines.push(`- 主持人：${Array.from(hosts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}(${v}次)`).join('、')}`);
    if (absentees.size) lines.push(`- 缺席频次Top：${Array.from(absentees.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}(${v}次)`).join('、')}`);
    return lines.join('\n');
  } catch (e) {
    return `例会数据查询失败：${e?.message || '未知错误'}`;
  }
}

// BI确定性回复：营业日报（daily_reports 表）
async function buildBiDeterministicDailyReportReply(store, text) {
  const q = String(text || '').trim();
  const targetStore = String(store || '').trim();
  if (!targetStore) return '';
  if (!/(营业额|营收|日报|毛利|点评评分|大众点评.*分|dianping|revenue|翻台|订单|客单价|会员|充值|业绩|达成率|目标|生意|经营情况|经营)/.test(q)) return '';
  const period = resolveDateRangeFromQuestion(q, 7);
  try {
    let sql = `SELECT * FROM daily_reports WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g')) = $1`;
    const params = [normalizeStoreKey(targetStore)];
    if (period.start) { sql += ` AND date >= $${params.length + 1}`; params.push(period.start); }
    if (period.end) { sql += ` AND date <= $${params.length + 1}`; params.push(period.end); }
    sql += ' ORDER BY date DESC LIMIT 60';
    const r = await pool().query(sql, params);
    const rows = r.rows || [];
    if (!rows.length) {
      // Fallback: 从 sales_raw 按日汇总
      try {
        const salesR = await pool().query(
          `SELECT s.date::text AS date, ROUND(SUM(COALESCE(s.revenue,0))::numeric, 2) AS day_revenue,
                  ROUND(SUM(COALESCE(s.sales_amount,0))::numeric, 2) AS day_sales
           FROM sales_raw s
           WHERE lower(regexp_replace(coalesce(s.store,''), '\\s+', '', 'g')) = $1
             AND s.date BETWEEN $2 AND $3
           GROUP BY s.date ORDER BY s.date DESC LIMIT 60`,
          [normalizeStoreKey(targetStore), period.start, period.end]
        );
        const sRows = salesR.rows || [];
        if (sRows.length) {
          const tRev = sRows.reduce((s, x) => s + (parseFloat(x.day_revenue) || 0), 0);
          const tSales = sRows.reduce((s, x) => s + (parseFloat(x.day_sales) || 0), 0);
          const sLines = [`📊 营业数据（${targetStore}·${period.label}）`];
          sLines.push(`- 统计天数：${sRows.length}天`);
          sLines.push(`- 累计实收：¥${tRev.toFixed(0)}`);
          if (tSales > 0) sLines.push(`- 累计折前：¥${tSales.toFixed(0)}`);
          sLines.push(`- 日均实收：¥${(tRev / sRows.length).toFixed(0)}`);
          sLines.push('> 数据源：sales_raw（销售明细按日汇总）');
          return sLines.join('\n');
        }
      } catch (_e) {}
      return `📊 ${period.label}营业数据（${targetStore}）：暂无营业数据。`;
    }
    const totalRevenue = rows.reduce((s, r) => s + (parseFloat(r.actual_revenue) || 0), 0);
    const totalTarget = rows.reduce((s, r) => s + (parseFloat(r.target_revenue) || 0), 0);
    const avgMargin = rows.filter(r => r.actual_margin != null);
    const avgMarginVal = avgMargin.length ? (avgMargin.reduce((s, r) => s + parseFloat(r.actual_margin), 0) / avgMargin.length).toFixed(1) : null;
    const dianpingRows = rows.filter(r => r.dianping_rating != null);
    const avgDianping = dianpingRows.length ? (dianpingRows.reduce((s, r) => s + parseFloat(r.dianping_rating), 0) / dianpingRows.length).toFixed(2) : null;
    const achieveRate = totalTarget > 0 ? (totalRevenue / totalTarget * 100).toFixed(1) : null;
    const lines = [`📊 营业数据（${targetStore}·${period.label}）`];
    lines.push(`- 统计天数：${rows.length}天`);
    lines.push(`- 累计营收：¥${totalRevenue.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`);
    if (totalTarget > 0) lines.push(`- 目标营收：¥${totalTarget.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}（达成率 ${achieveRate}%）`);
    lines.push(`- 日均营收：¥${(totalRevenue / rows.length).toFixed(0)}`);
    if (avgMarginVal) lines.push(`- 平均毛利率：${avgMarginVal}%`);
    if (avgDianping) lines.push(`- 大众点评均分：${avgDianping}`);
    // 趋势：最近3天 vs 之前
    if (rows.length >= 4) {
      const recent3 = rows.slice(0, 3).reduce((s, r) => s + (parseFloat(r.actual_revenue) || 0), 0) / 3;
      const older = rows.slice(3).reduce((s, r) => s + (parseFloat(r.actual_revenue) || 0), 0) / rows.slice(3).length;
      if (older > 0) {
        const trend = ((recent3 - older) / older * 100).toFixed(1);
        lines.push(`- 趋势：近3天日均 vs 之前 ${Number(trend) >= 0 ? '+' : ''}${trend}%`);
      }
    }
    return lines.join('\n');
  } catch (e) {
    return `营业数据查询失败：${e?.message || '未知错误'}`;
  }
}

async function buildBiDeterministicSalesRawTopReply(store, text) {
  const q = String(text || '').trim();
  const targetStore = String(store || '').trim();
  if (!targetStore) return '';
  // 避免误拦截“投诉/差评产品”类问题（应由差评查询处理）
  if (/(投诉|差评|负评|客诉|点评|评价.*差)/.test(q)) return '';
  // 只在明确“销售/销量”语义时触发，避免“产品/菜品”泛词造成误路由
  if (!/(热销|畅销|top|TOP|销量|卖得|卖的|销售明细|销售排行|销售排名|卖得最好|卖得最差|卖的最好|卖的最差|最好.*(产品|菜品)|最差.*(产品|菜品)|前\d+|后\d+)/.test(q)) return '';

  const period = resolveDateRangeFromQuestion(q, 30);
  let bizSql = '';
  if (/(外卖|takeaway|delivery)/i.test(q)) {
    bizSql = ` AND lower(regexp_replace(COALESCE(s.biz_type, ''), '\\s+', '', 'g')) IN ('takeaway','delivery','外卖','外送')`;
  } else if (/(堂食|dinein|店内)/i.test(q)) {
    bizSql = ` AND lower(regexp_replace(COALESCE(s.biz_type, ''), '\\s+', '', 'g')) IN ('dinein','堂食','店内','堂食点餐')`;
  }
  const limitMatch = q.match(/(top|TOP|前)\s*(\d{1,2})/);
  const limit = Math.max(1, Math.min(20, Number(limitMatch?.[2] || 10) || 10));
  const askWorst = /(最差|最不好卖|最难卖|倒数|垫底|卖不动|后\d+)/.test(q);
  const sortSql = askWorst ? 'ASC' : 'DESC';

  try {
    const r = await pool().query(
      `SELECT
         s.dish_name,
         ROUND(SUM(COALESCE(s.qty,0))::numeric, 2) AS total_qty,
         ROUND(SUM(COALESCE(s.sales_amount,0))::numeric, 2) AS total_sales,
         ROUND(SUM(COALESCE(s.revenue,0))::numeric, 2) AS total_revenue
       FROM sales_raw s
       WHERE lower(regexp_replace(COALESCE(s.store,''), '\\s+', '', 'g')) = $1
         AND s.date BETWEEN $2 AND $3
         ${bizSql}
         AND COALESCE(s.dish_name,'') <> ''
       GROUP BY s.dish_name
       HAVING SUM(COALESCE(s.qty,0)) > 0
       ORDER BY SUM(COALESCE(s.sales_amount,0)) ${sortSql}
       LIMIT ${limit}`,
      [normalizeStoreKey(targetStore), period.start, period.end]
    );
    const rows = r.rows || [];
    if (!rows.length) {
      return `📦 ${period.label}销售数据（${targetStore}）：暂无可用销售明细数据。`;
    }

    const title = askWorst ? `销售倒数${limit}` : `销售TOP${limit}`;
    const lines = [`📦 ${title}（${targetStore}·${period.label}）`];
    rows.forEach((x, i) => {
      lines.push(`${i + 1}. ${x.dish_name}｜折前¥${Number(x.total_sales || 0).toFixed(0)}｜实收¥${Number(x.total_revenue || 0).toFixed(0)}｜销量${Number(x.total_qty || 0).toFixed(0)}份`);
    });
    lines.push('> 数据源：sales_raw（门店销售明细）');
    return lines.join('\n');
  } catch (e) {
    return `销售排行查询失败：${e?.message || '未知错误'}`;
  }
}

// BI确定性回复：报损单统计
async function buildBiDeterministicLossReportReply(store, text) {
  const q = String(text || '').trim();
  const targetStore = String(store || '').trim();
  if (!targetStore) return '';
  if (!/(报损|损耗|废弃|报废|丢弃)/.test(q)) return '';
  const period = resolveDateRangeFromQuestion(q, 30);
  const tableId = String(BITABLE_CONFIGS?.loss_reports?.tableId || '').trim();
  if (!tableId) return `报损单数据源未配置，无法查询。`;
  try {
    const r = await pool().query(
      `SELECT fields FROM feishu_generic_records WHERE table_id = $1 ORDER BY updated_at DESC LIMIT 500`,
      [tableId]
    );
    const rows = (r.rows || []).filter(row => {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const rowStore = extractBitableFieldText(f['门店'] || f['所属门店'] || f['报损门店']);
      return !rowStore || isLikelySameStore(rowStore, targetStore);
    });
    if (!rows.length) return `📊 ${period.label}报损数据（${targetStore}）：暂无报损记录入库。`;
    const itemTop = new Map();
    let totalAmount = 0;
    rows.forEach(row => {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const item = extractBitableFieldText(f['报损品名'] || f['品名'] || f['物品名称'] || f['报损物品']);
      const amount = parseFloat(extractBitableFieldText(f['报损金额'] || f['金额'] || f['损失金额'])) || 0;
      if (item) itemTop.set(item, (itemTop.get(item) || 0) + 1);
      totalAmount += amount;
    });
    const lines = [`📊 报损数据（${targetStore}）`];
    lines.push(`- 报损记录：${rows.length}条`);
    if (totalAmount > 0) lines.push(`- 报损总额：¥${totalAmount.toFixed(2)}`);
    if (itemTop.size) lines.push(`- 报损品项Top：${Array.from(itemTop.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}(${v}次)`).join('、')}`);
    return lines.join('\n');
  } catch (e) {
    return `报损数据查询失败：${e?.message || '未知错误'}`;
  }
}

// BI确定性回复：差评报告/点评统计（数据源：feishu_generic_records + agent_messages）
async function buildBiDeterministicBadReviewReportReply(store, text) {
  const q = String(text || '').trim();
  const targetStore = String(store || '').trim();
  if (!targetStore) return '';
  if (!/(差评|负评|投诉|点评|评价.*差|差.*评价|大众点评|美团|评价.*结果|评价.*怎么样|评价.*情况)/.test(q)) return '';
  const period = resolveDateRangeFromQuestion(q, 30);
  const badReviewTableId = String(BITABLE_CONFIGS?.bad_reviews?.tableId || '').trim();
  try {
    // 从 feishu_generic_records 查差评报告原始数据
    let rows = [];
    if (badReviewTableId) {
      const r = await pool().query(
        `SELECT fields, created_at FROM feishu_generic_records WHERE table_id = $1 ORDER BY updated_at DESC LIMIT 500`,
        [badReviewTableId]
      );
      rows = (r.rows || []).filter(row => {
        const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
        const rowStore = extractBitableFieldText(f['差评门店'] || f['门店'] || f['所属门店']);
        return isLikelySameStore(rowStore, targetStore);
      });
    }
    // 补充从 agent_messages 查
    if (!rows.length) {
      const r2 = await pool().query(
        `SELECT agent_data as fields, created_at FROM agent_messages WHERE content_type = 'negative_review' ORDER BY created_at DESC LIMIT 500`
      );
      rows = (r2.rows || []).filter(row => {
        const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
        return isLikelySameStore(String(f.store || ''), targetStore);
      });
    }
    if (!rows.length) {
      return `📊 ${period.label}差评数据（${targetStore}）：暂无差评记录入库。`;
    }
    // 统计
    const productTop = new Map();
    const keywordTop = new Map();
    const platformTop = new Map();
    const samples = [];
    rows.forEach(row => {
      const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const product = extractBitableFieldText(f['差评产品'] || f.product_name);
      const keyword = extractBitableFieldText(f['差评关键词'] || f.keywords);
      const platform = extractBitableFieldText(f['差评平台'] || f.platform);
      const reason = extractBitableFieldText(f['差评原因'] || f.content || f.reason);
      if (product && product !== '无') productTop.set(product, (productTop.get(product) || 0) + 1);
      if (keyword) keyword.split(/[,，、]/).forEach(k => { k = k.trim(); if (k) keywordTop.set(k, (keywordTop.get(k) || 0) + 1); });
      if (platform) {
        const pText = Array.isArray(platform) ? platform.join('') : String(platform);
        pText.split(/[,，、]/).forEach(p => { p = p.trim(); if (p) platformTop.set(p, (platformTop.get(p) || 0) + 1); });
      }
      if (reason && samples.length < 3) samples.push(String(reason).slice(0, 80));
    });
    const topN = (m, n = 5) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}(${v})`).join('、') || '无';
    const lines = [`📊 差评数据（${targetStore}）`, `- 差评总数：${rows.length}条`];
    if (platformTop.size) lines.push(`- 来源平台：${topN(platformTop, 3)}`);
    if (productTop.size) lines.push(`- 差评产品Top：${topN(productTop)}`);
    if (keywordTop.size) lines.push(`- 关键词Top：${topN(keywordTop)}`);
    if (samples.length) {
      lines.push(`- 最新样例：`);
      samples.forEach(s => lines.push(`  · ${s}`));
    }
    return lines.join('\n');
  } catch (e) {
    return `差评数据查询失败：${e?.message || '未知错误'}`;
  }
}

function resolveModelProvider(modelName, forceProvider) {
  if (forceProvider) return forceProvider;
  const m = String(modelName || '').trim().toLowerCase();
  if (m.startsWith('qwen') || m.includes('dashscope')) return 'qwen';
  if (m.startsWith('doubao') || m.includes('volces') || m.includes('ark')) return 'doubao';
  return 'deepseek';
}

function getLLMClientConfig(modelName, options = {}) {
  const provider = resolveModelProvider(modelName, options.forceProvider || '');
  if (provider === 'qwen') {
    return {
      provider,
      model: String(modelName || '').trim() || QWEN_MODEL,
      apiKey: QWEN_API_KEY,
      baseUrl: QWEN_BASE_URL
    };
  }
  if (provider === 'doubao') {
    return {
      provider,
      model: String(modelName || '').trim() || DEEPSEEK_VISION_MODEL,
      apiKey: DOUBAO_API_KEY,
      baseUrl: DOUBAO_BASE_URL
    };
  }
  return {
    provider: 'deepseek',
    model: String(modelName || '').trim() || DEEPSEEK_MODEL,
    apiKey: DEEPSEEK_API_KEY,
    baseUrl: DEEPSEEK_BASE_URL
  };
}

const LARK_APP_ID = process.env.LARK_APP_ID || '';
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || '';
const LARK_ENCRYPT_KEY = process.env.LARK_ENCRYPT_KEY || '';
const LARK_VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN || '';

// Bitable Configuration - 支持多个配置
const BITABLE_CONFIGS = {
  'ops_checklist': {
    appId: process.env.BITABLE_OPS_APP_ID || 'cli_a91dae9f9578dcb1',
    appSecret: process.env.BITABLE_OPS_APP_SECRET || 'sjpAzPwu4KixvhbAOD7w4ee1oEKRRBQF',
    appToken: process.env.BITABLE_OPS_APP_TOKEN || 'PtVObRtoPaMAP3stIIFc8DnJngd',
    tableId: process.env.BITABLE_OPS_TABLE_ID || 'tblxHI9ZAKONOTpp',
    name: '运营检查表(含开收档)',
    type: 'checklist',
    pollingInterval: 60000,
    sortField: '["_id DESC"]'
  },
  'table_visit': {
    appId: process.env.BITABLE_TABLEVISIT_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_TABLEVISIT_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_TABLEVISIT_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_TABLEVISIT_TABLE_ID || 'tblpx5Efqc6eHo3L',
    name: '桌访表',
    type: 'table_visit',
    pollingInterval: 300000,
    sortField: '["日期 DESC"]'
  },
  'bad_reviews': {
    appId: process.env.BITABLE_TABLEVISIT_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_TABLEVISIT_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_TABLEVISIT_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: 'tblgReexNjWJOJB6',
    name: '差评报告DB',
    type: 'bad_review',
    pollingInterval: 300000,
    sortField: '["创建日期 DESC"]'
  },
  'closing_reports': {
    appId: process.env.BITABLE_CLOSING_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_CLOSING_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_CLOSING_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_CLOSING_TABLE_ID || 'tblXYfSBRrgNGohN',
    name: '收档报告DB',
    type: 'closing_report',
    pollingInterval: 300000,
    sortField: '["日期 DESC"]'
  },
  'opening_reports': {
    appId: process.env.BITABLE_OPENING_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_OPENING_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_OPENING_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_OPENING_TABLE_ID || 'tbl32E6d0CyvLvfi',
    name: '开档报告',
    type: 'opening_report',
    pollingInterval: 300000,
    sortField: '["日期 DESC"]'
  },
  'meeting_reports': {
    appId: process.env.BITABLE_MEETING_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_MEETING_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_MEETING_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_MEETING_TABLE_ID || 'tblZXgaU0LpSye2m',
    name: '例会报告',
    type: 'meeting_report',
    pollingInterval: 300000,
    sortField: '["日期 DESC"]'
  },
  'material_majixian': {
    appId: process.env.BITABLE_MATERIAL_MJX_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_MATERIAL_MJX_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_MATERIAL_MJX_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_MATERIAL_MJX_TABLE_ID || 'tblz4kW1cY22XRlL',
    name: '马己仙原料收货日报',
    type: 'material_report',
    brand: 'majixian',
    pollingInterval: 300000,
    sortField: '["日期 DESC"]'
  },
  'material_hongchao': {
    appId: process.env.BITABLE_MATERIAL_HC_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_MATERIAL_HC_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_MATERIAL_HC_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_MATERIAL_HC_TABLE_ID || 'tbllcV1evqTJyzlN',
    name: '洪潮原料收货日报',
    type: 'material_report',
    brand: 'hongchao',
    pollingInterval: 300000,
    sortField: '["日期 DESC"]'
  },
  'loss_reports': {
    appId: process.env.BITABLE_LOSS_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_LOSS_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_LOSS_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_LOSS_TABLE_ID || 'tblLCxLO0ZbV7uyo',
    name: '报损单',
    type: 'loss_report',
    pollingInterval: 300000,
    sortField: '["创建日期 DESC"]'
  },
  'task_responses': {
    appId: process.env.BITABLE_TABLEVISIT_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_TABLEVISIT_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_TASK_RESP_APP_TOKEN || 'BTAjbflrlaMRHesADUfc8usznqh',
    tableId: process.env.BITABLE_TASK_RESP_TABLE_ID || 'tblT86H1uuTJydne',
    name: '异常任务回复',
    type: 'task_response',
    pollingInterval: 60000,
    sortField: '["_id DESC"]'
  }
};

let BI_AGENT_CONFIG = {
  dataSources: [
    { key: 'daily_reports', enabled: true },
    { key: 'table_visit_records', enabled: true },
    { key: 'table_visit_bitable', enabled: true },
    { key: 'opening_reports_bitable', enabled: true },
    { key: 'closing_reports_bitable', enabled: true },
    { key: 'meeting_reports_bitable', enabled: true },
    { key: 'bad_reviews', enabled: true },
    { key: 'material_majixian_bitable', enabled: true },
    { key: 'material_hongchao_bitable', enabled: true },
    { key: 'ops_checklist_bitable', enabled: true },
    { key: 'loss_reports_bitable', enabled: true }
  ],
  anomalyTriggers: {
    global: {
      revenueGapMedium: 0.10,
      revenueGapHigh: 0.20,
      efficiencyMedium: 1100,
      efficiencyHigh: 1000,
      marginMedium: 0.69,
      marginHigh: 0.68,
      tableVisitProductMedium: 2,
      tableVisitProductHigh: 4,
      tableVisitRatioMedium: 0.5,
      tableVisitRatioHigh: 0.4,
      badReviewMedium: 1,
      badReviewHigh: 2,
      rechargeStreakHighDays: 2
    },
    storeOverrides: {}
  }
};

// 获取门店级别的异常阈值，门店覆盖 > 全局默认
function getStoreThreshold(storeName, key, fallback) {
  const triggers = BI_AGENT_CONFIG?.anomalyTriggers || {};
  const overrides = triggers.storeOverrides && typeof triggers.storeOverrides === 'object' ? triggers.storeOverrides : {};
  const storeConfig = overrides[storeName];
  if (storeConfig && storeConfig[key] !== undefined && storeConfig[key] !== null) {
    return Number(storeConfig[key]);
  }
  const globalConfig = triggers.global && typeof triggers.global === 'object' ? triggers.global : {};
  if (globalConfig[key] !== undefined && globalConfig[key] !== null) {
    return Number(globalConfig[key]);
  }
  return fallback;
}

async function refreshBiAgentRuntimeConfig() {
  try {
    const remote = await getBiAgentConfig();
    if (remote && typeof remote === 'object') {
      const remoteT = remote.anomalyTriggers || {};
      const localT = BI_AGENT_CONFIG?.anomalyTriggers || {};
      BI_AGENT_CONFIG = {
        ...BI_AGENT_CONFIG,
        ...remote,
        anomalyTriggers: {
          global: { ...(localT.global || {}), ...(remoteT.global || {}) },
          storeOverrides: { ...(localT.storeOverrides || {}), ...(remoteT.storeOverrides || {}) }
        }
      };
    }
  } catch (e) {
    console.error('[bi] refresh runtime config failed:', e?.message || e);
  }
}

function isBiSourceEnabled(key) {
  const list = Array.isArray(BI_AGENT_CONFIG?.dataSources) ? BI_AGENT_CONFIG.dataSources : [];
  const hit = list.find((x) => String(x?.key || '').trim() === String(key || '').trim());
  return hit ? hit.enabled !== false : true;
}

function getOpsReasoningModel() {
  const model = String(OPS_AGENT_CONFIG?.llmModels?.reasoningModel || '').trim();
  return model || DEEPSEEK_MODEL;
}

function getOpsVisionModel() {
  const model = String(OPS_AGENT_CONFIG?.llmModels?.visionModel || '').trim();
  if (model.startsWith('doubao-')) return model;
  return String(DEEPSEEK_VISION_MODEL || '').startsWith('doubao-') ? DEEPSEEK_VISION_MODEL : 'doubao-seed-2-0-pro-260215';
}

function getBiReasoningModel() {
  const model = String(BI_AGENT_CONFIG?.llmModels?.reasoningModel || '').trim();
  return model || DEEPSEEK_MODEL;
}

function formatChecklistTypeLabel(checkType) {
  const type = String(checkType || '').trim();
  const labels = { opening: '开市', closing: '收档', hygiene: '卫生巡检', food_safety: '食安检查', equipment: '设备巡检' };
  return labels[type] || type || '巡检';
}

async function refreshOpsAgentRuntimeConfig() {
  try {
    const remote = await getOpsAgentConfig();
    if (remote && typeof remote === 'object') {
      OPS_AGENT_CONFIG = {
        ...OPS_AGENT_CONFIG,
        ...remote,
        scheduledTasks: {
          ...(OPS_AGENT_CONFIG?.scheduledTasks || {}),
          ...(remote?.scheduledTasks || {})
        }
      };
    }
  } catch (e) {
    console.error('[ops] refresh runtime config failed:', e?.message || e);
  }
}

// 向后兼容的默认配置
const BITABLE_APP_ID = process.env.BITABLE_APP_ID || BITABLE_CONFIGS.ops_checklist.appId;
const BITABLE_APP_SECRET = process.env.BITABLE_APP_SECRET || BITABLE_CONFIGS.ops_checklist.appSecret;
const BITABLE_APP_TOKEN = process.env.BITABLE_APP_TOKEN || BITABLE_CONFIGS.ops_checklist.appToken;
const BITABLE_TABLE_ID = process.env.BITABLE_TABLE_ID || BITABLE_CONFIGS.ops_checklist.tableId;

const BRAND_ANALYSIS_CONFIG = {
  '洪潮': {
    marginTolerance: 0.01,
    scoreWeights: { quality: 0.4, cost: 0.3, response: 0.3 },
    label: '洪潮模式'
  },
  '马己仙': {
    marginTolerance: 0.02,
    scoreWeights: { efficiency: 0.4, cost: 0.4, execution: 0.2 },
    label: '马己仙模式'
  }
};

function normalizeBrandId(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  return raw
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

// 品牌配置
const BRAND_CONFIG = {
  '洪潮': {
    name: '洪潮',
    fullName: '洪潮传统潮汕菜',
    checkItems: {
      opening: ['地面清洁无积水', '所有设备正常开启', '食材新鲜度检查', '餐具消毒完成', '灯光亮度适中', '背景音乐开启', '空调温度设置合适', '员工仪容仪表检查'],
      closing: ['食材封存', '设备关闭', '垃圾清理', '安全检查', '门窗锁好']
    },
    standards: {
      quality: '高标准食材，新鲜度要求严格',
      service: '热情周到，响应及时',
      environment: '干净整洁，氛围舒适'
    }
  },
  '马己仙': {
    name: '马己仙',
    fullName: '马己仙',
    checkItems: {
      opening: ['地面清洁', '设备开启', '食材准备', '餐具消毒', '迎宾准备'],
      closing: ['食材封存', '设备关闭', '垃圾清理', '安全检查', '门窗锁好', '电源关闭']
    },
    standards: {
      quality: '精致料理，注重细节',
      service: '优雅服务，体验至上',
      environment: '高雅环境，品质生活'
    }
  }
};

function fallbackBrandConfigByName(brandName) {
  const name = String(brandName || '').trim();
  if (name.includes('马己仙')) return BRAND_CONFIG['马己仙'];
  return BRAND_CONFIG['洪潮'];
}

function getBrandsFromState(state0) {
  const state = state0 && typeof state0 === 'object' ? state0 : {};
  const stores = Array.isArray(state?.stores) ? state.stores : [];
  const existing = Array.isArray(state?.brands) ? state.brands : [];
  const map = new Map();

  existing.forEach((b) => {
    const name = String(b?.name || b?.label || '').trim();
    const id = normalizeBrandId(b?.id || b?.brandId || name);
    if (!name || !id) return;
    map.set(id, {
      id,
      name,
      config: b?.config && typeof b.config === 'object' ? b.config : {}
    });
  });

  stores.forEach((s) => {
    const name = String(s?.brand || s?.brandName || '').trim();
    const id = normalizeBrandId(s?.brandId || name);
    if (!name || !id || map.has(id)) return;
    map.set(id, { id, name, config: {} });
  });

  return Array.from(map.values());
}

function getBrandRuntimeConfig(state0, brandContext) {
  const brandName = String(brandContext?.brandName || '').trim();
  const fallback = fallbackBrandConfigByName(brandName);
  const custom = brandContext?.brandConfig && typeof brandContext.brandConfig === 'object' ? brandContext.brandConfig : {};
  return {
    ...fallback,
    ...custom,
    scoreWeights: custom?.scoreWeights && typeof custom.scoreWeights === 'object'
      ? custom.scoreWeights
      : fallback.scoreWeights,
    sopKeypoints: Array.isArray(custom?.sopKeypoints) ? custom.sopKeypoints : []
  };
}

function buildOpsChecklistItemDetailCard({ checkType, brandName, storeName, itemIndex, itemName, detail = {} }) {
  const typeLabel = formatChecklistTypeLabel(checkType);
  const statusLabel = detail.status === 'fail' ? '异常' : detail.status === 'pass' ? '合格' : '未选择';
  const remark = String(detail.remark || '').trim() || '未填写';
  const photoCount = Number(detail.photoCount) || 0;

  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: {
      title: { tag: 'plain_text', content: `${typeLabel}检查项填写` },
      template: 'indigo'
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**门店**：${storeName || '-'}\n**品牌**：${brandName || '-'}\n**检查项**：${itemIndex + 1}. ${itemName}`
        }
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `当前状态：${statusLabel}\n说明：${remark}\n已上传照片：${photoCount} 张\n\n下一步：先点击“合格/异常”，再直接在会话发送“说明：xxx”，然后上传照片。`
        }
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: 'primary',
            text: { tag: 'plain_text', content: '✅ 本项合格' },
            value: { action: 'ops_checklist_item_status', checkType, itemIndex: String(itemIndex), itemName, status: 'pass' }
          },
          {
            tag: 'button',
            type: 'danger',
            text: { tag: 'plain_text', content: '⚠️ 本项异常' },
            value: { action: 'ops_checklist_item_status', checkType, itemIndex: String(itemIndex), itemName, status: 'fail' }
          }
        ]
      }
    ]
  };
}

const _opsChecklistProgress = new Map();

// M3-FIX: 定期清理过期的检查表进度（每30分钟清理超过2小时的条目）
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, progress] of _opsChecklistProgress.entries()) {
    const createdAt = progress?.createdAt || 0;
    if (now - createdAt > 2 * 60 * 60 * 1000) { // 2小时过期
      _opsChecklistProgress.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`[ops] cleaned ${cleaned} expired checklist progress entries`);
}, 30 * 60 * 1000);

function getOpsChecklistProgressKey(openId, checkType, storeName) {
  const day = new Date().toISOString().slice(0, 10);
  return `${openId}||${storeName || '-'}||${checkType}||${day}`;
}

function countOpsChecklistCompleted(progress) {
  const details = progress?.itemDetails && typeof progress.itemDetails === 'object' ? progress.itemDetails : {};
  let done = 0;
  for (const v of Object.values(details)) {
    const statusOk = v && (v.status === 'pass' || v.status === 'fail');
    const remarkOk = String(v?.remark || '').trim().length > 0;
    if (statusOk && remarkOk) done += 1;
  }
  return done;
}

function countOpsChecklistAbnormal(progress) {
  const details = progress?.itemDetails && typeof progress.itemDetails === 'object' ? progress.itemDetails : {};
  let cnt = 0;
  for (const v of Object.values(details)) {
    if (v && v.status === 'fail') cnt += 1;
  }
  return cnt;
}

function buildOpsChecklistItemsCard({ checkType, brandName, storeName, checkedIndices = new Set() }) {
  const typeLabel = formatChecklistTypeLabel(checkType);
  const items = getOpsChecklistItems(checkType, storeName, brandName);
  const rows = (items.length ? items : ['现场环境检查', '设备状态检查', '安全规范检查'])
    .map((item, idx) => {
      const done = checkedIndices.has(idx);
      return {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: done ? 'primary' : 'default',
            text: { tag: 'plain_text', content: `${done ? '✅' : '⬜'} ${idx + 1}. ${item}` },
            value: { action: 'ops_checklist_item_focus', checkType, itemIndex: String(idx), itemName: item }
          }
        ]
      };
    });

  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: {
      title: { tag: 'plain_text', content: `${typeLabel}逐项勾选` },
      template: 'blue'
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**门店**：${storeName || '-'}\n**品牌**：${brandName || '-'}\n点击每一项完成勾选。`
        }
      },
      ...rows
    ]
  };
}

function buildOpsChecklistAbnormalItemsCard({ checkType, brandName, storeName }) {
  const typeLabel = formatChecklistTypeLabel(checkType);
  const items = getOpsChecklistItems(checkType, storeName, brandName);
  const rows = (items.length ? items : ['现场环境', '设备状态', '安全规范'])
    .map((item, idx) => ({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          type: 'danger',
          text: { tag: 'plain_text', content: `⚠️ ${idx + 1}. ${item}` },
          value: { action: 'ops_checklist_abnormal_item', checkType, itemIndex: String(idx), itemName: item }
        }
      ]
    }));

  rows.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        type: 'danger',
        text: { tag: 'plain_text', content: '⚠️ 其他异常' },
        value: { action: 'ops_checklist_abnormal_item', checkType, itemIndex: '-1', itemName: '其他异常' }
      }
    ]
  });

  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: {
      title: { tag: 'plain_text', content: `${typeLabel}异常项选择` },
      template: 'red'
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**门店**：${storeName || '-'}\n**品牌**：${brandName || '-'}\n请选择异常项（可多次点击提交）。`
        }
      },
      ...rows
    ]
  };
}

function detectOpsChecklistType(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.includes('开市') || t.includes('开档')) return 'opening';
  if (t.includes('收档') || t.includes('收市') || t.includes('闭市')) return 'closing';
  return '';
}

function getOpsChecklistItems(checkType, storeName = '', brandName = '') {
  const daily = OPS_AGENT_CONFIG?.scheduledTasks?.dailyInspections || [];
  const store = String(storeName || '').trim();
  const brand = String(brandName || '').trim();
  let target = daily.find((i) => i.type === checkType && String(i?.store || '').trim() === store && store);
  if (!target) target = daily.find((i) => i.type === checkType && String(i?.brand || '').trim() === brand && brand);
  if (!target) target = daily.find(i => i.type === checkType);
  return Array.isArray(target?.checklist) ? target.checklist : [];
}

function buildOpsChecklistCard({ checkType, brandName, storeName, abnormalCount = 0, totalCount = 0 }) {
  const typeLabel = formatChecklistTypeLabel(checkType);
  const items = getOpsChecklistItems(checkType, storeName, brandName);
  const listMd = items.length
    ? items.map((item, idx) => `${idx + 1}. ${item}`).join('\n')
    : '1. 现场环境检查\n2. 设备状态检查\n3. 安全规范检查';

  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: {
      title: { tag: 'plain_text', content: `${typeLabel}检查表（异常${abnormalCount}项）` },
      template: 'blue'
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**门店**：${storeName || '-'}\n**品牌**：${brandName || '-'}\n默认全部合格，仅需选择异常项并补充说明/照片。`
        }
      },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `检查项：\n${listMd}` } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: 'primary',
            text: { tag: 'plain_text', content: '✅ 直接提交（其余默认合格）' },
            value: { action: 'ops_checklist_submit', checkType }
          },
          {
            tag: 'button',
            type: 'danger',
            text: { tag: 'plain_text', content: '⚠️ 选择异常项（可多次）' },
            value: { action: 'ops_checklist_abnormal_open', checkType }
          }
        ]
      }
    ]
  };
}

function buildOpsChecklistTemplateText({ checkType, brandName, storeName }) {
  const typeLabel = formatChecklistTypeLabel(checkType);
  const items = getOpsChecklistItems(checkType, storeName, brandName);
  const lines = items.length
    ? items.map((item, idx) => `${idx + 1}. ${item}: [合格/异常] 备注:[ ]`).join('\n')
    : '1. 现场环境: [合格/异常] 备注:[ ]\n2. 设备状态: [合格/异常] 备注:[ ]\n3. 安全规范: [合格/异常] 备注:[ ]';
  return `【${typeLabel}检查标准模板】\n门店: ${storeName || '-'}\n品牌: ${brandName || '-'}\n\n${lines}\n\n异常说明: [如无填 无]\n整改完成时间: [YYYY-MM-DD HH:mm]\n上传照片数量: [N]\n\n请按以上格式直接回复，系统将自动结构化入库。`;
}

async function handleOpsChecklistCardAction(event) {
  const openId = String(
    event?.operator?.operator_id?.open_id ||
    event?.operator?.open_id ||
    event?.user?.open_id || ''
  ).trim();
  if (!openId) return { ok: true, skipped: 'no_open_id' };

  const actionValue = event?.action?.value || {};
  const action = String(actionValue.action || '').trim();
  if (!action.startsWith('ops_checklist_')) return { ok: true, skipped: 'not_ops_checklist_action' };

  const feishuUser = await lookupFeishuUser(openId);
  if (!feishuUser || !feishuUser.registered) {
    await sendLarkMessage(openId, '请先完成HRMS账号绑定后再提交检查表。');
    return { ok: true, skipped: 'unregistered_user' };
  }

  const sharedState = await getSharedState();
  const brandContext = resolveBrandContextByStore(sharedState, feishuUser.store || '');
  const brandName = String(brandContext?.brandName || '').trim();
  const storeName = String(feishuUser.store || '').trim();
  const checkType = String(actionValue.checkType || '').trim() || 'opening';
  const progressKey = getOpsChecklistProgressKey(openId, checkType, storeName);
  const checklistItems = getOpsChecklistItems(checkType, storeName, brandName);

  if (!_opsChecklistProgress.has(progressKey)) {
    _opsChecklistProgress.set(progressKey, {
      checked: new Set(),
      items: checklistItems,
      itemDetails: {},
      pendingItemIndex: null,
      pendingItemName: ''
    });
  }
  const progress = _opsChecklistProgress.get(progressKey);
  if (Array.isArray(progress?.items) && progress.items.length === 0 && checklistItems.length) {
    progress.items = checklistItems;
  }

  if (action === 'ops_checklist_abnormal_open') {
    const card = buildOpsChecklistAbnormalItemsCard({ checkType, brandName, storeName });
    const sendRes = await sendLarkCard(openId, card);
    if (!sendRes.ok) {
      await sendLarkMessage(openId, prefixWithAgentName('ops_supervisor', '异常项选择卡片发送失败，请稍后重试。'));
      return { toast: { type: 'error', content: '异常项卡片发送失败' }, ok: true, checklistAction: 'abnormal_open_failed' };
    }
    return {
      toast: { type: 'info', content: '请选择异常项提交' },
      ok: true,
      route: 'ops_supervisor',
      checklistAction: 'abnormal_opened'
    };
  }

  if (action === 'ops_checklist_abnormal_item') {
    const itemName = String(actionValue.itemName || '其他异常').trim() || '其他异常';
    const typeLabel = formatChecklistTypeLabel(checkType);
    const structured = {
      source: 'feishu_card_action',
      route: 'ops_supervisor',
      checkType,
      checkTypeLabel: typeLabel,
      status: 'fail',
      brand: brandName,
      store: storeName,
      username: feishuUser.username,
      abnormalItem: itemName,
      submittedAt: new Date().toISOString()
    };

    try {
      await pool().query(
        `INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, sender_role, routed_to, content_type, content, agent_data)
         VALUES ('in','feishu',$1,$2,$3,$4,'ops_supervisor','card_action',$5,$6::jsonb)`,
        [openId, feishuUser.username, feishuUser.name || feishuUser.username, feishuUser.role || '', `${typeLabel}异常项提交：${itemName}`, JSON.stringify(structured)]
      );
    } catch (e) {
      console.error('[ops] save checklist abnormal item failed:', e?.message);
    }

    progress.pendingItemIndex = Number.parseInt(String(actionValue.itemIndex || '-1'), 10);
    progress.pendingItemName = itemName;
    if (Number.isFinite(progress.pendingItemIndex) && progress.pendingItemIndex >= 0) {
      if (!progress.itemDetails[progress.pendingItemIndex]) progress.itemDetails[progress.pendingItemIndex] = { status: '', remark: '', photoCount: 0 };
      progress.itemDetails[progress.pendingItemIndex].status = 'fail';
    }

    await sendLarkMessage(openId, prefixWithAgentName('ops_supervisor', `已记录异常项：${itemName}。\n请直接回复：说明：你的说明\n并上传该项现场照片。`));
    return {
      toast: { type: 'success', content: `已提交异常：${itemName}` },
      ok: true,
      route: 'ops_supervisor',
      checklistAction: 'abnormal_item_submitted'
    };
  }

  if (action === 'ops_checklist_submit') {
    const typeLabel = formatChecklistTypeLabel(checkType);
    const items = progress?.items?.length ? progress.items : checklistItems;
    const total = Math.max(1, items.length);
    const abnormalCount = countOpsChecklistAbnormal(progress);

    const standardized = {
      source: 'feishu_card_action',
      route: 'ops_supervisor',
      checkType,
      checkTypeLabel: typeLabel,
      status: abnormalCount > 0 ? 'fail' : 'pass',
      brand: brandName,
      store: storeName,
      username: feishuUser.username,
      checklist: items,
      checklistProgress: { total, abnormalCount, passCount: Math.max(0, total - abnormalCount) },
      itemDetails: progress?.itemDetails || {},
      submittedAt: new Date().toISOString()
    };

    try {
      await pool().query(
        `INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, sender_role, routed_to, content_type, content, agent_data)
         VALUES ('in','feishu',$1,$2,$3,$4,'ops_supervisor','card_action',$5,$6::jsonb)`,
        [openId, feishuUser.username, feishuUser.name || feishuUser.username, feishuUser.role || '', `${typeLabel}检查表提交（异常${abnormalCount}项）`, JSON.stringify(standardized)]
      );
    } catch (e) {
      console.error('[ops] save checklist card action failed:', e?.message);
    }

    const reply = `已收到你的${typeLabel}检查表提交 ✅\n异常项：${abnormalCount}，其余默认合格。\n如需补充异常说明/照片，可继续发送“说明：xxx”+图片。`;
    await sendLarkMessage(openId, prefixWithAgentName('ops_supervisor', reply));
    _opsChecklistProgress.delete(progressKey);
    return {
      toast: { type: 'success', content: '检查表已提交' },
      ok: true,
      route: 'ops_supervisor',
      checklistAction: 'submit'
    };
  }

  return { ok: true, skipped: 'unknown_ops_action' };
}

export function resolveBrandContextByStore(state0, storeRef) {
  const state = state0 && typeof state0 === 'object' ? state0 : {};
  const stores = Array.isArray(state?.stores) ? state.stores : [];
  const brands = getBrandsFromState(state);
  const byId = new Map(brands.map((b) => [String(b.id || ''), b]));
  const ref = String(storeRef || '').trim();
  const row = stores.find((s) => String(s?.id || '').trim() === ref || String(s?.name || '').trim() === ref) || null;
  const storeName = String(row?.name || ref || '').trim();
  const brandNameFromStore = String(row?.brand || row?.brandName || '').trim();
  const brandId = normalizeBrandId(row?.brandId || brandNameFromStore || inferBrandFromStoreName(storeName));
  const brand = byId.get(brandId) || null;
  const brandName = String(brand?.name || brandNameFromStore || inferBrandFromStoreName(storeName) || '').trim();
  const brandConfig = brand?.config && typeof brand.config === 'object' ? brand.config : {};
  return {
    storeId: String(row?.id || '').trim(),
    storeName,
    brandId,
    brandName,
    brandConfig
  };
}

// ─────────────────────────────────────────────
// 1. Database / Blackboard
// ─────────────────────────────────────────────

let _pool = null;
export function setPool(p) { 
  _pool = p; 
  setUnifiedAgentPool(p); // 同时设置统一数据库连接
}
export function pool() { 
  if (!_pool) throw new Error('agents: pool not set'); 
  return _pool; 
}

// Hook for Master Agent task response handler (set by master-agent.js to avoid circular import)
let _taskResponseHook = null;
export function setTaskResponseHook(fn) { _taskResponseHook = fn; }

export async function ensureAgentTables() {
  const migrationFile = path.join(path.dirname(new URL(import.meta.url).pathname), 'migrations', '005_agent_p0p2_tables.sql');
  try {
    const sql = fs.readFileSync(migrationFile, 'utf-8');
    await pool().query(sql);
    console.log('[agents] Migration 005_agent_p0p2_tables.sql applied successfully');
  } catch (e) {
    const code = String(e?.code || '');
    if (code === '23505') return;
    console.error('[agents] ensureAgentTables migration failed:', e?.message || e);
  }
}

// ─────────────────────────────────────────────
// 2. LLM Helpers & Context Management
// ─────────────────────────────────────────────

// 上下文缓存：存储最近的对话历史
// M2-FIX: 添加最大用户数限制，防止内存泄漏
const _conversationContext = new Map();
const MAX_CONTEXT_LENGTH = 10;
const MAX_CONTEXT_USERS = 500;

// 响应缓存：避免重复调用LLM
const _responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

// 性能监控
const _performanceMetrics = {
  totalCalls: 0,
  cacheHits: 0,
  avgResponseTime: 0,
  errorCount: 0
};

function getCachedResponse(cacheKey) {
  const cached = _responseCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    _performanceMetrics.cacheHits++;
    return cached.response;
  }
  return null;
}

function setCachedResponse(cacheKey, response) {
  _responseCache.set(cacheKey, {
    response,
    timestamp: Date.now()
  });
  
  // 清理过期缓存
  if (_responseCache.size > 100) {
    const now = Date.now();
    for (const [key, value] of _responseCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        _responseCache.delete(key);
      }
    }
  }
}

function updateContext(userId, role, content) {
  if (!_conversationContext.has(userId)) {
    _conversationContext.set(userId, []);
  }
  const context = _conversationContext.get(userId);
  context.push({ role, content, timestamp: Date.now() });
  
  // 保持最近10轮对话
  if (context.length > MAX_CONTEXT_LENGTH) {
    context.shift();
  }
  
  // 清理过期上下文（1小时）
  const now = Date.now();
  while (context.length > 0 && now - context[0].timestamp > 3600000) {
    context.shift();
  }
  
  // M2-FIX: 限制总用户数，淘汰最旧的用户上下文
  if (_conversationContext.size > MAX_CONTEXT_USERS) {
    let oldestKey = null, oldestTime = Infinity;
    for (const [key, ctx] of _conversationContext.entries()) {
      const lastTs = ctx.length > 0 ? ctx[ctx.length - 1].timestamp : 0;
      if (lastTs < oldestTime) { oldestTime = lastTs; oldestKey = key; }
    }
    if (oldestKey) _conversationContext.delete(oldestKey);
  }
}

function getContext(userId) {
  return _conversationContext.get(userId) || [];
}

function markQualityMetric(field, delta = 1) {
  if (!Object.prototype.hasOwnProperty.call(_agentQualityMetrics, field)) return;
  _agentQualityMetrics[field] = Number(_agentQualityMetrics[field] || 0) + Number(delta || 0);
  _agentQualityMetrics.lastUpdatedAt = new Date().toISOString();
}

async function getAgentLongMemory(userKey, memoryKey) {
  const u = String(userKey || '').trim().toLowerCase();
  const k = String(memoryKey || '').trim();
  if (!u || !k) return null;
  try {
    const r = await pool().query(
      `SELECT memory_value FROM agent_long_memory WHERE user_key = $1 AND memory_key = $2 LIMIT 1`,
      [u, k]
    );
    const row = r.rows?.[0];
    return row?.memory_value && typeof row.memory_value === 'object' ? row.memory_value : null;
  } catch (e) {
    return null;
  }
}

async function setAgentLongMemory(userKey, memoryKey, value) {
  const u = String(userKey || '').trim().toLowerCase();
  const k = String(memoryKey || '').trim();
  if (!u || !k) return;
  const payload = value && typeof value === 'object' ? value : { value: String(value || '') };
  try {
    await pool().query(
      `INSERT INTO agent_long_memory (user_key, memory_key, memory_value, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW(), NOW())
       ON CONFLICT (user_key, memory_key)
       DO UPDATE SET memory_value = EXCLUDED.memory_value, updated_at = NOW()`,
      [u, k, JSON.stringify(payload)]
    );
  } catch (e) {
    console.error('[agents] setAgentLongMemory failed:', e?.message || e);
  }
}

async function recordAgentQualityAudit({ route, username, queryText, responseText, auditResult, passed, rewriteCount = 0 }) {
  try {
    await pool().query(
      `INSERT INTO agent_quality_audits (route, username, query_text, response_text, audit_result, passed, rewrite_count)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        String(route || '').trim(),
        String(username || '').trim(),
        String(queryText || '').slice(0, 1000),
        String(responseText || '').slice(0, 4000),
        JSON.stringify(auditResult || {}),
        passed === true,
        Math.max(0, Number(rewriteCount) || 0)
      ]
    );
  } catch (e) {}
}

function buildAutonomousTaskFingerprint({ taskType, store, route, queryText }) {
  const raw = `${String(taskType || '').trim()}|${normalizeStoreKey(store)}|${String(route || '').trim()}|${normalizePlainText(queryText || '', 300)}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

async function createOrUpdateAutonomousDataTask({
  taskType,
  store,
  brand,
  requesterUsername,
  route,
  queryText,
  reason,
  evidence,
  ownerUsername,
  dueHours = 8
}) {
  const fingerprint = buildAutonomousTaskFingerprint({ taskType, store, route, queryText });
  try {
    const r = await pool().query(
      `INSERT INTO agent_autonomous_tasks (
         fingerprint, task_type, status, store, brand, requester_username, route,
         query_text, reason, evidence, action_plan, owner_username, notify_count, due_at, created_at, updated_at
       )
       VALUES (
         $1, $2, 'open', $3, $4, $5, $6,
         $7, $8, $9::jsonb, $10::jsonb, $11, 0, NOW() + make_interval(hours => $12), NOW(), NOW()
       )
       ON CONFLICT (fingerprint)
       DO UPDATE SET
         reason = EXCLUDED.reason,
         evidence = EXCLUDED.evidence,
         owner_username = COALESCE(agent_autonomous_tasks.owner_username, EXCLUDED.owner_username),
         updated_at = NOW()
       RETURNING *`,
      [
        fingerprint,
        String(taskType || 'data_gap').trim() || 'data_gap',
        String(store || '').trim(),
        String(brand || '').trim(),
        String(requesterUsername || '').trim(),
        String(route || '').trim(),
        String(queryText || '').slice(0, 2000),
        String(reason || '').slice(0, 500),
        JSON.stringify(evidence || {}),
        JSON.stringify({ suggestedAction: '同步/补齐数据源后自动回访用户', createdBy: 'agent_autonomy' }),
        String(ownerUsername || '').trim(),
        Math.max(1, Math.min(72, Number(dueHours) || 8))
      ]
    );
    markQualityMetric('autonomousTasks', 1);
    return r.rows?.[0] || null;
  } catch (e) {
    console.error('[agents] createOrUpdateAutonomousDataTask failed:', e?.message || e);
    return null;
  }
}

async function notifyAutonomousDataTaskOwner(task) {
  const t = task && typeof task === 'object' ? task : null;
  if (!t) return;
  const owner = String(t.owner_username || '').trim();
  if (!owner) return;
  try {
    const fu = await lookupFeishuUserByUsername(owner);
    if (!fu?.open_id) return;
    const msg = [
      `📌 自治任务提醒 [${t.task_type}]`,
      `门店：${t.store || '-'}`,
      `原因：${t.reason || '数据不足'}`,
      `用户问题：${String(t.query_text || '').slice(0, 120)}`,
      `请补齐数据源后在系统内关闭任务。`
    ].join('\n');
    await sendLarkMessage(fu.open_id, prefixWithAgentName('master', msg));
    await pool().query(
      `UPDATE agent_autonomous_tasks
       SET notify_count = COALESCE(notify_count, 0) + 1, updated_at = NOW()
       WHERE id = $1`,
      [t.id]
    );
  } catch (e) {
    console.error('[agents] notifyAutonomousDataTaskOwner failed:', e?.message || e);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableLLMError(err) {
  const status = Number(err?.response?.status || 0);
  if ([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524].includes(status)) return true;
  const code = String(err?.code || '').toLowerCase();
  if (['econnreset', 'etimedout', 'eai_again', 'enotfound', 'ecanceled'].includes(code)) return true;
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('socket hang up') ||
    msg.includes('network error') ||
    msg.includes('bad record mac') ||
    msg.includes('incomplete envelope') ||
    msg.includes('tls')
  );
}

export async function callLLM(messages, options = {}) {
  const role = String(options.role || '').trim();
  const purpose = String(options.purpose || 'reasoning').trim();
  const tier = role ? getModelTier(role) : '';
  const tierModel = role ? getModelForRole(role, purpose) : '';
  const selectedModel = String(options.model || tierModel || DEEPSEEK_MODEL).trim() || DEEPSEEK_MODEL;
  const cfg = getLLMClientConfig(selectedModel);
  const model = cfg.model;
  const apiKey = cfg.apiKey;
  if (!apiKey) return { ok: false, error: 'no_api_key', content: '' };

  const budgetExceeded = !!(tier && isTierBudgetExceeded(tier));
  const defaultTemp = role ? getTemperatureForRole(role) : 0.1;
  const requestedTemp = Number(options.temperature ?? defaultTemp);
  const temperature = Number.isFinite(requestedTemp)
    ? (budgetExceeded ? Math.min(0.05, requestedTemp) : requestedTemp)
    : (budgetExceeded ? 0 : 0.1);
  const roleMaxTokens = role ? getMaxTokensForRole(role) : 1500;
  const requestedMax = Number(options.max_tokens ?? roleMaxTokens);
  const maxTokens = Number.isFinite(requestedMax)
    ? (budgetExceeded ? Math.max(256, Math.min(600, requestedMax)) : requestedMax)
    : (budgetExceeded ? 512 : 1500);
  
  // 生成缓存键
  const cacheKey = `${model}:${JSON.stringify(messages.slice(-2))}:${temperature}:${purpose}:${role}`;
  
  // 检查缓存
  const cachedResponse = getCachedResponse(cacheKey);
  if (cachedResponse && !options.skipCache) {
    return { ok: true, content: cachedResponse, cached: true };
  }
  
  const startTime = Date.now();
  _performanceMetrics.totalCalls++;
  
  // ── Provider 级别自动降级：primary → fallback ──
  const hasTools = !!(options.tools && options.tools.length > 0);
  const fallbackChain = hasTools ? [{ provider: resolveModelProvider(model), model }] : getTextFallbackChain(model);
  let usedModel = model;
  let usedProvider = resolveModelProvider(model);

  for (const candidate of fallbackChain) {
    if (!isProviderHealthy(candidate.provider)) {
      console.log(`[LLM-FALLBACK] Skipping unhealthy provider: ${candidate.provider}`);
      continue;
    }
    const fbCfg = getLLMClientConfig(candidate.model);
    if (!fbCfg.apiKey) continue;

    const payload = {
      model: fbCfg.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      top_p: budgetExceeded ? 0.7 : 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.1
    };
    if (hasTools) {
      payload.tools = options.tools;
      if (options.tool_choice) payload.tool_choice = options.tool_choice;
    }

    const maxAttempts = candidate.provider === usedProvider ? 2 : 1;
    let resp = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        resp = await axios.post(
          `${fbCfg.baseUrl}/chat/completions`,
          payload,
          { headers: { 'Authorization': `Bearer ${fbCfg.apiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 }
        );
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < maxAttempts && isRetryableLLMError(e)) {
          const waitMs = 600 * attempt;
          console.warn(`[LLM-FALLBACK] ${candidate.provider} transient error (attempt ${attempt}/${maxAttempts}), retry in ${waitMs}ms:`, e?.message || e);
          await sleep(waitMs);
          continue;
        }
      }
    }

    if (resp) {
      markProviderOk(candidate.provider);
      usedModel = fbCfg.model;
      usedProvider = candidate.provider;

      const messageObj = resp.data?.choices?.[0]?.message || {};
      const content = messageObj.content || '';
      const responseTime = Date.now() - startTime;

      _performanceMetrics.avgResponseTime =
        (_performanceMetrics.avgResponseTime * (_performanceMetrics.totalCalls - 1) + responseTime) /
        _performanceMetrics.totalCalls;

      if (!options.skipCache && content && !messageObj.tool_calls) {
        setCachedResponse(cacheKey, content);
      }
      if (tier && options.trackTier === true) {
        try { trackLLMCall(tier, Number(resp.data?.usage?.total_tokens || 0)); } catch (e) {}
      }

      trackLLMResult(true);
      const isFallback = candidate.provider !== resolveModelProvider(model);
      if (isFallback) console.log(`[LLM-FALLBACK] ✅ Succeeded via fallback: ${candidate.provider}/${fbCfg.model} (primary was ${resolveModelProvider(model)}/${model})`);
      return { ok: true, content, message: messageObj, raw: resp.data, responseTime, budgetExceeded, fallbackUsed: isFallback ? candidate.provider : undefined, actualModel: usedModel };
    }

    markProviderFail(candidate.provider);
    console.warn(`[LLM-FALLBACK] ❌ Provider ${candidate.provider}/${fbCfg.model} failed: ${lastErr?.message || 'unknown'}`);
  }

  _performanceMetrics.errorCount++;
  trackLLMResult(false);
  console.error('[agents] callLLM ALL providers failed for model chain:', fallbackChain.map(c => c.provider).join(' → '));
  return { ok: false, error: 'all_providers_failed', content: '', providerHealth: getProviderHealthStatus() };
}

export async function callVisionLLM(imageUrl, prompt) {
  const model = getOpsVisionModel();
  const cfg = getLLMClientConfig(model, { forceProvider: 'doubao' });
  const apiKey = cfg.apiKey;
  if (!apiKey) return { ok: false, error: 'no_api_key', content: '' };
  try {
    const content = [];
    if (Array.isArray(imageUrl)) {
      for (const item of imageUrl) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'text') {
          content.push({ type: 'text', text: String(item.text || '').trim() });
        } else if (item.type === 'image' && item.image_url) {
          content.push({ type: 'image_url', image_url: { url: String(item.image_url) } });
        } else if (item.type === 'image_url') {
          const url = typeof item.image_url === 'string' ? item.image_url : item.image_url?.url;
          if (url) content.push({ type: 'image_url', image_url: { url: String(url) } });
        }
      }
    } else {
      const imagePath = String(imageUrl || '').trim();
      let imageContent;
      if (imagePath.startsWith('data:') || imagePath.startsWith('http')) {
        imageContent = { type: 'image_url', image_url: { url: imagePath } };
      } else {
        const buf = fs.readFileSync(imagePath);
        const b64 = buf.toString('base64');
        const ext = path.extname(imagePath).replace('.', '') || 'jpeg';
        imageContent = { type: 'image_url', image_url: { url: `data:image/${ext};base64,${b64}` } };
      }
      content.push(imageContent);
      if (prompt) content.push({ type: 'text', text: String(prompt) });
    }

    if (!content.length && prompt) content.push({ type: 'text', text: String(prompt) });
    if (!content.length) return { ok: false, error: 'invalid_vision_input', content: '' };

    let resp = null;
    let lastErr = null;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        resp = await axios.post(
          `${cfg.baseUrl}/chat/completions`,
          {
            model: cfg.model,
            messages: [{ role: 'user', content }],
            temperature: 0.2, max_tokens: 1500
          },
          { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 90000 }
        );
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < maxAttempts && isRetryableLLMError(e)) {
          const waitMs = 800 * attempt;
          console.warn(`[agents] callVisionLLM transient error (attempt ${attempt}/${maxAttempts}), retry in ${waitMs}ms:`, e?.message || e);
          await sleep(waitMs);
          continue;
        }
      }
    }
    if (!resp) throw lastErr || new Error('vision_request_failed');
    trackLLMResult(true);
    return { ok: true, content: resp.data?.choices?.[0]?.message?.content || '', raw: resp.data };
  } catch (e) {
    trackLLMResult(false);
    console.error('[agents] callVisionLLM error:', e?.message || e);
    return { ok: false, error: String(e?.message || e), content: '' };
  }
}

export async function queryKnowledgeBase(agent, query, limit = 5, options = {}) {
  // 委托给 RAG 多维知识库工具（兼容旧调用签名）
  try {
    let ragModule;
    try { ragModule = await import('./rag-tool.js'); } catch (e) { /* fallback below */ }
    if (ragModule?.ragQuery) {
      const agentName = Array.isArray(agent) ? 'sop_advisor' : String(agent || 'master_agent').trim();
      const queryStr = Array.isArray(query) ? query : (Array.isArray(agent) ? agent.join(' ') : String(query || ''));
      const result = await ragModule.ragQuery({
        agentName, userRole: options?.userRole || 'admin',
        query: queryStr, brandTag: options?.brandTag, limit
      });
      return (result?.results || []).map(r => ({ title: r.title, content: r.content, tags: r.tags, created_at: r.createdAt }));
    }
    // fallback: 直接查询
    const brandTag = String(options?.brandTag || '').trim();
    const r = await pool().query(
      `SELECT title, content, tags, created_at FROM knowledge_base WHERE ($1 = '' OR tags && $1) AND (content ILIKE $2 OR title ILIKE $2) ORDER BY created_at DESC LIMIT $3`,
      [brandTag, `%${query}%`, limit]
    );
    return r.rows || [];
  } catch (e) {
    console.error('[agents] queryKnowledgeBase error:', e?.message);
    return [];
  }
}

// Query Bitable data for all agents
export async function queryBitableData(agent, query, limit = 10, options = {}) {
  try {
    const contentType = options?.contentType || '';
    const configKey = options?.configKey || '';
    
    let whereClause = `content_type IN ('bitable_submission', 'table_visit', 'vision_analysis')`;
    let params = [`%${query}%`, limit];
    
    if (contentType) {
      whereClause += ` AND content_type = $${params.length + 1}`;
      params.push(contentType);
    }
    
    if (configKey) {
      whereClause += ` AND agent_data::text ILIKE $${params.length + 1}`;
      params.push(`%"configKey":"${configKey}"%`);
    }
    
    const r = await pool().query(
      `SELECT content, content_type, agent_data, created_at, sender_name
       FROM agent_messages 
       WHERE ${whereClause} 
         AND (content ILIKE $1 OR agent_data::text ILIKE $1)
       ORDER BY created_at DESC 
       LIMIT $2`,
      params
    );
    
    return r.rows || [];
  } catch (e) {
    console.error('[agents] queryBitableData error:', e?.message);
    return [];
  }
}

// Unified query function for all agents
export async function queryAgentData(agent, query, limit = 10, options = {}) {
  const includeBitable = options?.includeBitable !== false;
  const includeKnowledge = options?.includeKnowledge !== false;
  
  const results = {
    knowledge: [],
    bitable: []
  };
  
  if (includeKnowledge) {
    results.knowledge = await queryKnowledgeBase(agent, query, limit, options);
  }
  
  if (includeBitable) {
    results.bitable = await queryBitableData(agent, query, limit, options);
  }
  
  return results;
}

// ─────────────────────────────────────────────
// 3. Shared State Helpers
// ─────────────────────────────────────────────

export async function getSharedState() {
  const r = await pool().query('SELECT data FROM hrms_state WHERE key = $1 LIMIT 1', ['default']);
  return r.rows?.[0]?.data && typeof r.rows[0].data === 'object' ? r.rows[0].data : {};
}

function findUserInState(state, username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  const all = [
    ...(Array.isArray(state?.employees) ? state.employees : []),
    ...(Array.isArray(state?.users) ? state.users : [])
  ];
  return all.find(x => String(x?.username || '').trim().toLowerCase() === u) || null;
}

export function getStoresFromState(state) {
  const stores = Array.isArray(state?.stores) ? state.stores : [];
  return stores.map(s => ({
    id: String(s?.id || '').trim(),
    name: String(s?.name || '').trim(),
    brand: String(s?.brand || s?.brandName || '').trim(),
    brandId: normalizeBrandId(s?.brandId || s?.brand || s?.brandName)
  })).filter(s => s.name);
}

export function inferBrandFromStoreName(storeName) {
  const s = String(storeName || '').trim();
  if (s.includes('马己仙')) return '马己仙';
  if (s.includes('洪潮')) return '洪潮';
  return '';
}

function resolveBrand(state, store) {
  const ctx = resolveBrandContextByStore(state, store);
  return ctx?.brandName || inferBrandFromStoreName(store) || '洪潮';
}

export async function findStoreManager(state, storeName) {
  const all = [
    ...(Array.isArray(state?.employees) ? state.employees : []),
    ...(Array.isArray(state?.users) ? state.users : [])
  ];
  const normalizedStoreName = normalizeStoreKey(storeName);
  const mgr = all.find(u =>
    normalizeStoreKey(u?.store) === normalizedStoreName &&
    String(u?.role || '').trim() === 'store_manager'
  );
  return mgr ? String(mgr.username || '').trim() : null;
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toDateOnly(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  try {
    const d = new Date(s);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  } catch (e) {
    return '';
  }
}

function inDateRangeInclusive(v, start, end) {
  const d = toDateOnly(v);
  if (!d) return false;
  const s = toDateOnly(start);
  const e = toDateOnly(end);
  if (s && d < s) return false;
  if (e && d > e) return false;
  return true;
}

function normProductKey(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, '');
}

function normalizeStoreKey(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, '');
}

function normalizeStoreAliasKey(v) {
  return normalizeStoreKey(v).replace(/(上海|北京|深圳|广州|大宁|门店|店铺|店|商场|广场|购物中心)/g, '');
}

function isExactSameStore(a, b) {
  return normalizeStoreKey(a) && normalizeStoreKey(a) === normalizeStoreKey(b);
}

function isLikelySameStore(a, b) {
  const x = normalizeStoreKey(a);
  const y = normalizeStoreKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  const ax = normalizeStoreAliasKey(a);
  const by = normalizeStoreAliasKey(b);
  if (ax && by && (ax === by || ax.includes(by) || by.includes(ax))) return true;
  return false;
}

function normalizeBitableDateValue(v, fallback = '') {
  if (v === null || v === undefined || v === '') return toDateOnly(fallback);
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v * 1000;
    return toDateOnly(new Date(ms).toISOString());
  }
  const s = String(v || '').trim();
  if (!s) return toDateOnly(fallback);
  if (/^\d{13}$/.test(s) || /^\d{10}$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) {
      const ms = s.length === 13 ? n : n * 1000;
      return toDateOnly(new Date(ms).toISOString());
    }
  }
  return toDateOnly(s) || toDateOnly(fallback);
}

// 从飞书多维表格的复杂字段值中提取纯文本
// 支持格式: string, [{text_arr:[...]}, ...], [{text:"..."}], array等
function extractBitableFieldText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val)) {
    const parts = [];
    for (const item of val) {
      if (typeof item === 'string') { parts.push(item); continue; }
      if (item && typeof item === 'object') {
        if (Array.isArray(item.text_arr) && item.text_arr.length) {
          parts.push(...item.text_arr.map(t => String(t || '').trim()).filter(Boolean));
        } else if (item.text) {
          parts.push(String(item.text).trim());
        }
      }
    }
    return parts.join('，').trim();
  }
  if (typeof val === 'object' && val.text) return String(val.text).trim();
  return String(val).trim();
}

// 从飞书 fields 中按优先级提取桌访不满意菜品字段
function extractDissatisfactionDishFromFields(fields) {
  // 优先级：精确匹配 > 模糊匹配
  const candidates = [
    fields['今天 不满意菜品'],        // 实际飞书字段名(有空格)
    fields['今天不满意菜品'],          // 无空格变体
    fields['今日不满意菜品'],          // 旧代码变体
    fields['不满意菜品'],
    fields['不满意菜品/问题'],
  ];
  for (const v of candidates) {
    const text = extractBitableFieldText(v);
    if (text) return text;
  }
  return '';
}

// 从飞书 fields 中提取不满意原因
function extractDissatisfactionReasonFromFields(fields) {
  const candidates = [
    fields['满意或不满意的主要原因是什么？'],
    fields['满意或不满意的主要原因'],
    fields['不满意项'],
    fields['不满意原因'],
    fields['备注'],
  ];
  for (const v of candidates) {
    const text = extractBitableFieldText(v);
    if (text) return text;
  }
  return '';
}

function extractTableVisitItems(row) {
  const dishText = String(row?.dissatisfaction_dish || '').trim();
  const reasonText = String(row?.unsatisfied_items || '').trim();

  const dishItems = dishText
    ? dishText
        .split(/[，,、\/;；|\n\r\t\s]+/)
        .map((k) => String(k || '').trim())
        .filter(Boolean)
    : [];

  const negativePattern = /太[咸淡冷油辣热硬]|有点[咸淡冷硬腥慢小挤]|不满意|不好吃|不新鲜|不够|偏[咸淡]|等[很太]久|等了[很太]久|上菜[有稍]?[点微]?慢|不[满熟行]|肿了|太老|没有肉感|不是很满意|该[咸淡]的不[咸淡]/;

  const reasonItems = reasonText && negativePattern.test(reasonText)
    ? reasonText
        .split(/[，,、\/;；|\n\r\t\s]+/)
        .map((k) => String(k || '').trim())
        .filter(Boolean)
    : [];

  return [...dishItems, ...reasonItems].filter((x) => x && !/卤鹅/.test(String(x)));
}

function extractTableVisitDishes(row) {
  const raw = String(row?.dissatisfaction_dish || '').trim();
  if (!raw) return [];
  const blocked = new Set(['无', '没有', '暂无', '无菜品', '不清楚', '未知', '其他']);
  return raw
    .split(/[，,、\/;；|\n\r\t\s]+/)
    .map((k) => String(k || '').trim())
    .filter((k) => k && !blocked.has(k));
}

async function loadUnifiedTableVisitRowsByStore(store, startDate, endDate) {
  const normalizedStore = normalizeStoreKey(store);
  if (!normalizedStore) return [];

  // 1) Structured table first (preferred)
  let structured = [];
  try {
    const r = await pool().query(
      `SELECT date::text AS date, store, dissatisfaction_dish, unsatisfied_items
       FROM table_visit_records
       WHERE date >= $1::date
         AND date <= $2::date
       ORDER BY date DESC
       LIMIT 5000`,
      [startDate, endDate]
    );
    const candidates = Array.isArray(r.rows) ? r.rows : [];
    structured = candidates.filter((row) => isLikelySameStore(row?.store, store));
  } catch (e) {
    structured = [];
  }
  if (structured.length) return structured;

  // 2) Fallback to generic sync cache (more robust when structured sync is delayed)
  try {
    const tableId = String(BITABLE_CONFIGS?.table_visit?.tableId || '').trim();
    if (!tableId) return [];

    const g = await pool().query(
      `SELECT record_id, fields, created_at
       FROM feishu_generic_records
       WHERE table_id = $1
         AND created_at >= CURRENT_DATE - INTERVAL '40 days'
       ORDER BY updated_at DESC
       LIMIT 4000`,
      [tableId]
    );

    const seenRecordIds = new Set();
    const exactOut = [];
    const likelyOut = [];
    for (const row of (g.rows || [])) {
      const recordId = String(row?.record_id || '').trim();
      if (!recordId || seenRecordIds.has(recordId)) continue;
      seenRecordIds.add(recordId);
      const fields = row?.fields && typeof row.fields === 'object' ? row.fields : {};
      const rowStore = String(fields['所属门店'] || fields['门店'] || '').trim();
      const exact = isExactSameStore(rowStore, store);
      const likely = isLikelySameStore(rowStore, store);
      if (!exact && !likely) continue;
      const date = normalizeBitableDateValue(fields['日期'] || fields['营业日期'], row?.created_at);
      if (!inDateRangeInclusive(date, startDate, endDate)) continue;
      const normalized = {
        date,
        dissatisfaction_dish: extractDissatisfactionDishFromFields(fields),
        unsatisfied_items: extractDissatisfactionReasonFromFields(fields)
      };
      if (exact) exactOut.push(normalized);
      else likelyOut.push(normalized);
    }
    return exactOut.length ? exactOut : likelyOut;
  } catch (e) {
    return [];
  }
}

function getMonthlyTarget(state, ym, store) {
  const settings = state?.settings && typeof state.settings === 'object' ? state.settings : {};
  const monthlyTargets = Array.isArray(settings?.monthlyTargets)
    ? settings.monthlyTargets
    : (Array.isArray(state?.monthlyTargets) ? state.monthlyTargets : []);
  const normalizedStore = normalizeStoreKey(store);
  return monthlyTargets.find((x) =>
    String(x?.ym || x?.month || '').trim() === ym &&
    normalizeStoreKey(x?.store) === normalizedStore
  ) || null;
}

function getActualRevenueFromHistoryRow(row) {
  const actual = Math.max(0, toNum(row?.actualRevenue, 0));
  if (actual > 0) return actual;
  const expected = Math.max(0, toNum(row?.expectedRevenue, 0));
  const discount = Math.max(0, toNum(row?.totalDiscount, 0));
  return Math.max(0, expected - discount);
}

function daysInMonth(dateStr) {
  const d = toDateOnly(dateStr);
  if (!d) return 30;
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return 30;
  return new Date(y, m, 0).getDate();
}

function isConsecutiveDate(prevDate, currDate) {
  const p = toDateOnly(prevDate);
  const c = toDateOnly(currDate);
  if (!p || !c) return false;
  const d1 = new Date(`${p}T00:00:00`).getTime();
  const d2 = new Date(`${c}T00:00:00`).getTime();
  if (!Number.isFinite(d1) || !Number.isFinite(d2)) return false;
  return (d2 - d1) === 86400000;
}

function buildGrossProfileMap(profiles, store) {
  const map = new Map();
  const normalizedStore = normalizeStoreKey(store);
  (Array.isArray(profiles) ? profiles : [])
    .filter((x) => normalizeStoreKey(x?.store) === normalizedStore)
    .forEach((x) => {
      const bizType = String(x?.bizType || '').trim().toLowerCase();
      const productKey = normProductKey(x?.product);
      if (!productKey) return;
      const key = `${bizType}||${productKey}`;
      map.set(key, {
        costPerUnit: toNum(x?.costPerUnit ?? x?.cost, NaN),
        grossPerUnit: toNum(x?.grossPerUnit ?? x?.grossProfit ?? x?.profitPerUnit, NaN)
      });
      if (bizType) {
        map.set(`||${productKey}`, {
          costPerUnit: toNum(x?.costPerUnit ?? x?.cost, NaN),
          grossPerUnit: toNum(x?.grossPerUnit ?? x?.grossProfit ?? x?.profitPerUnit, NaN)
        });
      }
    });
  return map;
}

async function estimateMarginMetricsForRange({ state, store, startDate, endDate }) {
  const normalizedStore = normalizeStoreKey(store);
  const historyRows = (Array.isArray(state?.inventoryForecastHistory) ? state.inventoryForecastHistory : [])
    .filter((x) => normalizeStoreKey(x?.store) === normalizedStore)
    .filter((x) => inDateRangeInclusive(x?.date, startDate, endDate));
  const profiles = Array.isArray(state?.forecastGrossProfitProfiles) ? state.forecastGrossProfitProfiles : [];
  const profileMap = buildGrossProfileMap(profiles, store);
  try {
    const dlR = await pool().query(`SELECT biz_type,dish_name,unit_cost FROM dish_library_costs WHERE enabled=TRUE AND (lower(regexp_replace(coalesce(store,''),'\\s+','','g'))=$1 OR store='*')`, [normalizeStoreKey(store)]);
    for (const r of (dlR.rows||[])) { const biz=String(r.biz_type||'').trim().toLowerCase(); const pk=normProductKey(r.dish_name); const c=toNum(r.unit_cost,NaN); if(!pk||!Number.isFinite(c)||c<0) continue; if(!profileMap.has(`${biz}||${pk}`)) profileMap.set(`${biz}||${pk}`,{costPerUnit:c,grossPerUnit:NaN}); if(!profileMap.has(`||${pk}`)) profileMap.set(`||${pk}`,{costPerUnit:c,grossPerUnit:NaN}); }
  } catch(e) { console.error('[margin] dish_library_costs query error:', e?.message||e); }

  const out = {
    takeaway: { actualRevenue: 0, estimatedCost: 0, marginRate: 0 },
    dinein: { actualRevenue: 0, estimatedCost: 0, marginRate: 0 },
    total: { actualRevenue: 0, estimatedCost: 0, marginRate: 0 }
  };

  for (const row of historyRows) {
    const bizTypeRaw = String(row?.bizType || '').trim().toLowerCase();
    const bizType = bizTypeRaw === 'takeaway' || bizTypeRaw === 'delivery' || bizTypeRaw === '外卖'
      ? 'takeaway'
      : (bizTypeRaw === 'dinein' || bizTypeRaw === 'dine_in' || bizTypeRaw === '堂食' ? 'dinein' : '');
    if (!bizType) continue;

    const actualRevenue = getActualRevenueFromHistoryRow(row);
    out[bizType].actualRevenue += actualRevenue;
    out.total.actualRevenue += actualRevenue;

    const products = row?.productQuantities && typeof row.productQuantities === 'object' ? row.productQuantities : {};
    const entries = Object.entries(products)
      .map(([name, qtyRaw]) => ({ name, qty: toNum(qtyRaw, 0) }))
      .filter((x) => x.qty > 0);
    const totalQty = entries.reduce((s, x) => s + x.qty, 0);
    if (!totalQty) continue;

    const expectedRevenue = Math.max(0, toNum(row?.expectedRevenue, 0));
    for (const entry of entries) {
      const key = normProductKey(entry.name);
      if (!key) continue;
      const profile = profileMap.get(`${bizType}||${key}`) || profileMap.get(`||${key}`) || null;
      if (!profile) continue;

      let estimatedCost = 0;
      if (Number.isFinite(profile.costPerUnit) && profile.costPerUnit >= 0) {
        estimatedCost = entry.qty * profile.costPerUnit;
      } else if (Number.isFinite(profile.grossPerUnit) && profile.grossPerUnit >= 0 && expectedRevenue > 0) {
        const allocRevenue = (entry.qty / totalQty) * expectedRevenue;
        estimatedCost = Math.max(0, allocRevenue - entry.qty * profile.grossPerUnit);
      }

      out[bizType].estimatedCost += estimatedCost;
      out.total.estimatedCost += estimatedCost;
    }
  }

  const calcRate = (actualRevenue, estimatedCost) => {
    if (!(actualRevenue > 0)) return 0;
    return Math.max(0, 1 - (estimatedCost / actualRevenue));
  };

  out.takeaway.marginRate = calcRate(out.takeaway.actualRevenue, out.takeaway.estimatedCost);
  out.dinein.marginRate = calcRate(out.dinein.actualRevenue, out.dinein.estimatedCost);
  out.total.marginRate = calcRate(out.total.actualRevenue, out.total.estimatedCost);

  return out;
}

async function loadTableVisitMetricsByStore(store, startDate, endDate) {
  const out = {
    countByDate: new Map(),
    dissatisfiedProducts: new Map(),
    dissatisfiedByDate: new Map(),
    productLabelByKey: new Map()
  };
  try {
    const normalizedStore = normalizeStoreKey(store);
    if (!normalizedStore) return out;

    const rows = await loadUnifiedTableVisitRowsByStore(store, startDate, endDate);
    for (const row of rows) {
      const d = String(row?.date || '').slice(0, 10);
      if (!d) continue;
      out.countByDate.set(d, (out.countByDate.get(d) || 0) + 1);

      extractTableVisitItems(row).forEach((product) => {
        if (/卤鹅/.test(String(product || ''))) return;
        const productKey = normProductKey(product);
        if (!productKey) return;
        const key = `${normalizedStore}||${productKey}`;
        out.dissatisfiedProducts.set(key, (out.dissatisfiedProducts.get(key) || 0) + 1);
        if (!out.productLabelByKey.has(productKey)) out.productLabelByKey.set(productKey, product);
        const dateSet = out.dissatisfiedByDate.get(d) || new Set();
        dateSet.add(productKey);
        out.dissatisfiedByDate.set(d, dateSet);
      });
    }
  } catch (e) {
    // table may not exist in some envs; keep auditor running
  }
  return out;
}

// ─────────────────────────────────────────────
// 4. Feishu Client
// ─────────────────────────────────────────────

let _larkTenantToken = null;
let _larkTenantTokenExpires = 0;
let _bitableTenantTokens = new Map(); // 支持多个配置的 token

// 获取飞书租户token
async function getLarkTenantToken() {
  // 检查缓存的token
  if (_larkTenantToken && Date.now() < _larkTenantTokenExpires) {
    return _larkTenantToken;
  }
  
  try {
    const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: LARK_APP_ID,
      app_secret: LARK_APP_SECRET
    }, { timeout: 10000 });
    
    const token = resp.data?.tenant_access_token || '';
    const expires = Date.now() + (resp.data?.expire || 7000) * 1000;
    
    _larkTenantToken = token;
    _larkTenantTokenExpires = expires;
    
    console.log('[feishu] tenant token refreshed, expires in', resp.data?.expire, 's');
    return token;
  } catch (e) {
    console.error('[feishu] get tenant token failed:', e?.message);
    return '';
  }
}

async function getBitableTenantToken(configKey = 'ops_checklist') {
  const config = BITABLE_CONFIGS[configKey];
  if (!config) {
    console.error(`[bitable] invalid config key: ${configKey}`);
    return '';
  }
  
  // 检查缓存的 token
  const cached = _bitableTenantTokens.get(configKey);
  if (cached && Date.now() < cached.expires) {
    return cached.token;
  }
  
  try {
    const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: config.appId, app_secret: config.appSecret
    }, { timeout: 10000 });
    
    const token = resp.data?.tenant_access_token || '';
    const expires = Date.now() + (resp.data?.expire || 7000) * 1000;
    
    _bitableTenantTokens.set(configKey, { token, expires });
    console.log(`[bitable][${configKey}] tenant token refreshed, expires in`, resp.data?.expire, 's');
    return token;
  } catch (e) {
    console.error(`[bitable][${configKey}] get tenant token failed:`, e?.message);
    return '';
  }
}

// ─────────────────────────────────────────────
// Bitable API Client
// ─────────────────────────────────────────────

export async function getBitableRecords(configKey = 'ops_checklist', options = {}) {
  const config = BITABLE_CONFIGS[configKey];
  if (!config) {
    console.error(`[bitable] invalid config key: ${configKey}`);
    return { ok: false, error: 'invalid_config' };
  }
  
  const token = await getBitableTenantToken(configKey);
  if (!token) {
    console.error(`[bitable][${configKey}] cannot get records: no token`);
    return { ok: false, error: 'no_token' };
  }

  const { pageSize = 20, pageToken, filter, sort = [] } = options;
  const params = {
    page_size: pageSize,
    user_id_type: 'open_id'
  };
  
  if (pageToken) params.page_token = pageToken;
  if (filter) params.filter = filter;
  if (sort.length > 0) {
    params.sort = JSON.stringify(sort);
  } else if (config.sortField) {
    params.sort = config.sortField;
  } else {
    params.sort = JSON.stringify(["_id DESC"]);
  }
  
  

  try {
    const resp = await axios.get(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        params,
        timeout: 15000
      }
    );

    const records = resp.data?.data?.items || [];
    const hasMore = resp.data?.data?.has_more || false;
    const nextPageToken = resp.data?.data?.page_token || '';
    const total = resp.data?.data?.total || 0;

    return { ok: true, records, hasMore, nextPageToken, total };
  } catch (e) {
    console.error('[bitable] get records failed:', e?.response?.data || e?.message);
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function getBitableRecordImageDownloadUrl(configKey = 'ops_checklist', fileToken) {
  const token = await getBitableTenantToken();
  if (!token) {
    console.error('[bitable] cannot get image url: no token');
    return null;
  }

  try {
    // 方法1：使用 drive API 获取下载链接
    const resp = await axios.get(
      `https://open.feishu.cn/open-apis/drive/v1/files/${fileToken}/download_url`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 10000
      }
    );

    const downloadUrl = resp.data?.data?.download_url || '';
    if (downloadUrl) {
      console.log('[bitable] got image download url for token:', fileToken);
      return downloadUrl;
    }
    return null;
  } catch (e) {
    console.error('[bitable] get image download url failed:', e?.response?.data || e?.message);
    
    // 方法2：尝试使用 media API
    try {
      const mediaResp = await axios.get(
        `https://open.feishu.cn/open-apis/drive/v1/medias/${fileToken}/download`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: 10000
        }
      );
      
      if (mediaResp.data) {
        console.log('[bitable] got media download for token:', fileToken);
        // 直接返回图片数据或临时URL
        return `data:image/jpeg;base64,${Buffer.from(mediaResp.data).toString('base64')}`;
      }
    } catch (e2) {
      console.error('[bitable] media download also failed:', e2?.response?.data || e2?.message);
    }
    
    return null;
  }
}

// 桌访数据处理
async function processTableVisitData(records) {
  console.log(`[table_visit] processing ${records.length} records`);
  
  for (const record of records) {
    const fields = record.fields || {};
    
    // 解析桌访数据（根据实际字段调整）
    const tableVisitData = {
      recordId: record.record_id,
      createdTime: record.created_time,
      date: fields['日期'] || '',
      store: fields['所属门店'] || '',
      brand: fields['所属品牌'] || '',
      tableNumber: fields['桌号'] || '',
      customerCount: fields['就餐人数'] || fields['人数'] || 0,
      consumption: fields['消费金额'] || 0,
      hasReservation: fields['是否有预订'] || '',
      dissatisfactionDish: extractDissatisfactionDishFromFields(fields),
      remarks: fields['备注'] || '',
      submitter: fields['提交人'] || '',
      fields
    };
    
    console.log(`[table_visit] new record:`, tableVisitData);
    
    // 存储到数据库
    try {
      await pool().query(`
        INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, sender_role, routed_to, content_type, content, agent_data, record_id)
        VALUES ('in','feishu',$1,$2,$3,$4,'ops_supervisor','table_visit',$5,$6::jsonb,$7)
      `, [
        tableVisitData.submitter?.id || '',
        tableVisitData.submitter?.name || '',
        tableVisitData.submitter?.name || '',
        'table_visit_submitter',
        `桌访数据提交 - ${tableVisitData.store} 桌${tableVisitData.tableNumber}`,
        JSON.stringify(tableVisitData),
        tableVisitData.recordId
      ]);
      
      console.log(`[table_visit] saved record: ${tableVisitData.recordId}`);

      // 稳定同步：同时写入结构化表，便于BI精确查询
      const visitDate = normalizeBitableDateValue(fields['日期'] || fields['营业日期'], record.created_time);
      const visitStore = String(fields['所属门店'] || fields['门店'] || '').trim();
      if (visitDate && visitStore) {
        await pool().query(
          `INSERT INTO table_visit_records (
            date, store, brand, table_number, guest_count, amount,
            has_reservation, dissatisfaction_dish, unsatisfied_items, feedback,
            feishu_record_id, updated_at
          ) VALUES (
            $1::date,$2,$3,$4,$5,$6,
            $7,$8,$9,$10,
            $11,NOW()
          )
          ON CONFLICT (feishu_record_id) DO UPDATE SET
            date = EXCLUDED.date,
            store = EXCLUDED.store,
            brand = EXCLUDED.brand,
            table_number = EXCLUDED.table_number,
            guest_count = EXCLUDED.guest_count,
            amount = EXCLUDED.amount,
            has_reservation = EXCLUDED.has_reservation,
            dissatisfaction_dish = EXCLUDED.dissatisfaction_dish,
            unsatisfied_items = EXCLUDED.unsatisfied_items,
            feedback = EXCLUDED.feedback,
            updated_at = NOW()`,
          [
            visitDate,
            visitStore,
            String(fields['所属品牌'] || fields['品牌'] || '').trim(),
            String(fields['桌号'] || '').trim(),
            Number(fields['就餐人数'] || fields['人数'] || 0) || 0,
            Number(fields['消费金额'] || 0) || 0,
            String(fields['是否有预订'] || '').includes('是'),
            extractDissatisfactionDishFromFields(fields),
            extractDissatisfactionReasonFromFields(fields),
            String(fields['备注'] || '').trim(),
            String(record.record_id || '').trim()
          ]
        );
      }
    } catch (e) {
      // 忽略重复记录错误
      if (!e?.message?.includes('duplicate')) {
        console.error(`[table_visit] save failed for ${tableVisitData.recordId}:`, e?.message);
      }
    }
  }
}

async function processBadReviewData(records) {
  for (const record of records) {
    try {
      const fields = record.fields || {};
      const recordId = record.record_id;
      const createdTime = record.created_time;
      const dateVal = fields['差评日期'] || fields['创建日期'] || createdTime;
      
      const tableData = {
        recordId: recordId,
        date: dateVal,
        store: fields['差评门店'] || '',
        platform: Array.isArray(fields['差评平台']) ? fields['差评平台'].join(',') : (fields['差评平台'] || ''),
        product: fields['差评产品'] || '',
        reason: fields['差评原因'] || '',
        keywords: fields['差评关键词'] || '',
        rating: fields['星级'] || '',
        extractedInfo: fields['提取信息'] || ''
      };
      
      await pool().query(`
        WITH updated AS (
          UPDATE agent_messages
          SET content = $1,
              agent_data = $2::jsonb,
              updated_at = CURRENT_TIMESTAMP
          WHERE record_id = $3
          RETURNING id
        )
        INSERT INTO agent_messages (direction, channel, content_type, content, agent_data, record_id)
        SELECT 'in','feishu','negative_review',$1,$2::jsonb,$3
        WHERE NOT EXISTS (SELECT 1 FROM updated)
      `, [
        `差评记录 - ${tableData.store}`,
        JSON.stringify(tableData),
        recordId
      ]);
    } catch(e) {
      console.error('[bitable] bad review process error:', e?.message);
    }
  }
}

// 检查表数据处理（保持原有逻辑）
async function processChecklistData(records) {
  console.log(`[checklist] processing ${records.length} records`);
  // ... 原有的检查表处理逻辑
}

// 根据配置类型处理数据
export async function processBitableData(configKey, records) {
  const config = BITABLE_CONFIGS[configKey];
  if (!config) {
    console.error(`[bitable] invalid config key: ${configKey}`);
    return;
  }
  
  switch (config.type) {
    case 'checklist':
      return await processChecklistData(records);
    case 'table_visit':
      return await processTableVisitData(records);
    case 'bad_review':
      return await processBadReviewData(records);
    case 'closing_report':
      return await processClosingReportData(records);
    case 'opening_report':
      return await processOpeningReportData(records);
    case 'meeting_report':
      return await processMeetingReportData(records);
    case 'material_report':
      return await processMaterialReportData(records, config.brand);
    default:
      console.log(`[bitable][${configKey}] unknown type: ${config.type}, processing as generic`);
      return await processGenericData(records, configKey);
  }
}

// 通用数据处理
async function processGenericData(records, configKey) {
  for (const record of records) {
    console.log(`[bitable][${configKey}] generic record:`, record.record_id);
    
    try {
      await pool().query(`
        WITH updated AS (
          UPDATE agent_messages
          SET content = $1,
              agent_data = $2::jsonb,
              updated_at = NOW()
          WHERE record_id = $3
          RETURNING id
        )
        INSERT INTO agent_messages (direction, channel, content_type, content, agent_data, record_id)
        SELECT 'in','feishu','generic_bitable',$1,$2::jsonb,$3
        WHERE NOT EXISTS (SELECT 1 FROM updated)
      `, [
        `通用数据 - ${configKey}`,
        JSON.stringify({ configKey, recordId: record.record_id, fields: record.fields }),
        record.record_id
      ]);
    } catch (e) {
      console.error(`[bitable][${configKey}] save generic record failed:`, e?.message);
    }
  }
}

// 收档报告数据处理
async function processClosingReportData(records) {
  for (const record of records) {
    console.log(`[bitable] closing report record:`, record.record_id);
    
    try {
      const fields = record.fields || {};
      await pool().query(`
        WITH updated AS (
          UPDATE agent_messages
          SET content = $1,
              agent_data = $2::jsonb,
              updated_at = CURRENT_TIMESTAMP
          WHERE record_id = $3
          RETURNING id
        )
        INSERT INTO agent_messages (direction, channel, content_type, content, agent_data, record_id)
        SELECT 'in','feishu','closing_report',$1,$2::jsonb,$3
        WHERE NOT EXISTS (SELECT 1 FROM updated)
      `, [
        '收档报告',
        JSON.stringify({ 
          type: 'closing_report', 
          recordId: record.record_id, 
          fields: {
            store: fields['门店'],
            date: fields['日期'],
            station: fields['档口'],
            responsible: fields['本档口值班负责人'],
            handover_time: fields['交接时间'],
            inventory_check: fields['本档口库存检查'],
            cleaning_status: fields['本档口清洁卫生'],
            equipment_status: fields['设备使用情况'],
            temperature_record: fields['温度记录'],
            handover_person: fields['交接人'],
            handover_receiver: fields['接收人'],
            issues: fields['异常情况说明'],
            submit_time: fields['提交时间']
          }
        }),
        record.record_id
      ]);
    } catch (e) {
      console.error(`[bitable] save closing report record failed:`, e?.message);
    }
  }
}

// 开档报告数据处理
async function processOpeningReportData(records) {
  for (const record of records) {
    console.log(`[bitable] opening report record:`, record.record_id);
    
    try {
      const fields = record.fields || {};
      await pool().query(`
        WITH updated AS (
          UPDATE agent_messages
          SET content = $1,
              agent_data = $2::jsonb,
              updated_at = CURRENT_TIMESTAMP
          WHERE record_id = $3
          RETURNING id
        )
        INSERT INTO agent_messages (direction, channel, content_type, content, agent_data, record_id)
        SELECT 'in','feishu','opening_report',$1,$2::jsonb,$3
        WHERE NOT EXISTS (SELECT 1 FROM updated)
      `, [
        '开档报告',
        JSON.stringify({ 
          type: 'opening_report', 
          recordId: record.record_id, 
          fields: {
            store: fields['门店'],
            date: fields['日期'],
            station: fields['档口'],
            responsible: fields['本档口值班负责人'],
            preparation_time: fields['开档时间'],
            inventory_check: fields['本档口库存检查'],
            cleaning_status: fields['本档口清洁卫生'],
            equipment_status: fields['设备使用情况'],
            temperature_check: fields['温度检查'],
            staff_ready: fields['人员准备情况'],
            issues: fields['异常情况说明'],
            submit_time: fields['提交时间']
          }
        }),
        record.record_id
      ]);
    } catch (e) {
      console.error(`[bitable] save opening report record failed:`, e?.message);
    }
  }
}

// 例会报告数据处理
async function processMeetingReportData(records) {
  for (const record of records) {
    console.log(`[bitable] meeting report record:`, record.record_id);
    
    try {
      const fields = record.fields || {};
      await pool().query(`
        WITH updated AS (
          UPDATE agent_messages
          SET content = $1,
              agent_data = $2::jsonb,
              updated_at = CURRENT_TIMESTAMP
          WHERE record_id = $3
          RETURNING id
        )
        INSERT INTO agent_messages (direction, channel, content_type, content, agent_data, record_id)
        SELECT 'in','feishu','meeting_report',$1,$2::jsonb,$3
        WHERE NOT EXISTS (SELECT 1 FROM updated)
      `, [
        '例会报告',
        JSON.stringify({ 
          type: 'meeting_report', 
          recordId: record.record_id, 
          fields: {
            store: fields['门店'],
            date: fields['日期'],
            meeting_type: fields['会议类型'],
            organizer: fields['组织人'],
            participants: fields['参会人员'],
            meeting_time: fields['会议时间'],
            duration: fields['会议时长'],
            topics: fields['会议议题'],
            decisions: fields['决议事项'],
            action_items: fields['行动项'],
            next_meeting: fields['下次会议时间'],
            submit_time: fields['提交时间']
          }
        }),
        record.record_id
      ]);
    } catch (e) {
      console.error(`[bitable] save meeting report record failed:`, e?.message);
    }
  }
}

// 原料收货报告数据处理
async function processMaterialReportData(records, brand) {
  for (const record of records) {
    console.log(`[bitable] material report record (${brand}):`, record.record_id);
    
    try {
      const fields = record.fields || {};
      await pool().query(`
        WITH updated AS (
          UPDATE agent_messages
          SET content = $1,
              agent_data = $2::jsonb,
              updated_at = CURRENT_TIMESTAMP
          WHERE record_id = $3
          RETURNING id
        )
        INSERT INTO agent_messages (direction, channel, content_type, content, agent_data, record_id)
        SELECT 'in','feishu','material_report',$1,$2::jsonb,$3
        WHERE NOT EXISTS (SELECT 1 FROM updated)
      `, [
        `${brand}原料收货日报`,
        JSON.stringify({ 
          type: 'material_report', 
          recordId: record.record_id, 
          brand: brand,
          fields: {
            store: fields['门店'],
            date: fields['日期'],
            material_name: fields['原料名称'],
            supplier: fields['供应商'],
            quantity: fields['数量'],
            unit: fields['单位'],
            unit_price: fields['单价'],
            total_price: fields['总价'],
            quality_check: fields['质量检查'],
            storage_location: fields['存储位置'],
            receiver: fields['收货人'],
            delivery_person: fields['送货人'],
            notes: fields['备注'],
            submit_time: fields['提交时间']
          }
        }),
        record.record_id
      ]);
    } catch (e) {
      console.error(`[bitable] save material report record failed:`, e?.message);
    }
  }
}

const _bitableArchiveThresholdDays = 7; // 7天后归档（更激进）
const _bitableDeleteThresholdDays = 60; // 60天后删除（2个月）

export async function archiveOldBitableSubmissions() {
  console.log('[bitable] starting data archive process...');
  
  try {
    // 1. 创建归档表（如果不存在）
    await pool().query(`
      CREATE TABLE IF NOT EXISTS bitable_submissions_archive (
        LIKE agent_messages INCLUDING ALL
      )
    `);
    
    // 2. 查找需要归档的记录
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - _bitableArchiveThresholdDays);
    
    const oldRecords = await pool().query(`
      SELECT * FROM agent_messages 
      WHERE content_type = 'bitable_submission' 
        AND created_at < $1
        AND record_id NOT IN (SELECT record_id FROM bitable_submissions_archive)
      ORDER BY created_at ASC
    `, [cutoffDate.toISOString()]);
    
    if (oldRecords.rows.length === 0) {
      console.log('[bitable] no records to archive');
      return { archived: 0, deleted: 0 };
    }
    
    console.log(`[bitable] found ${oldRecords.rows.length} records to archive`);
    
    // 3. 移动到归档表
    let archivedCount = 0;
    for (const record of oldRecords.rows) {
      try {
        await pool().query(`
          INSERT INTO bitable_submissions_archive (
            id, direction, channel, feishu_open_id, sender_username, sender_name, 
            sender_role, routed_to, content_type, content, agent_data, 
            created_at, updated_at, feishu_message_id, image_urls
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `, [
          record.id, record.direction, record.channel, record.feishu_open_id,
          record.sender_username, record.sender_name, record.sender_role,
          record.routed_to, record.content_type, record.content, record.agent_data,
          record.created_at, record.updated_at, record.feishu_message_id,
          record.image_urls
        ]);
        
        // 删除原记录
        await pool().query('DELETE FROM agent_messages WHERE id = $1', [record.id]);
        archivedCount++;
      } catch (e) {
        console.error(`[bitable] failed to archive record ${record.id}:`, e?.message);
      }
    }
    
    // 4. 删除超过删除阈值的记录
    const deleteCutoffDate = new Date();
    deleteCutoffDate.setDate(deleteCutoffDate.getDate() - _bitableDeleteThresholdDays);
    
    const deleteResult = await pool().query(`
      DELETE FROM bitable_submissions_archive 
      WHERE created_at < $1
    `, [deleteCutoffDate.toISOString()]);
    
    const deletedCount = deleteResult.rowCount || 0;
    
    console.log(`[bitable] archive completed: ${archivedCount} archived, ${deletedCount} deleted`);
    
    return { archived: archivedCount, deleted: deletedCount };
    
  } catch (e) {
    console.error('[bitable] archive process failed:', e?.message);
    return { archived: 0, deleted: 0, error: String(e?.message) };
  }
}

export async function getBitableSubmissionStats() {
  try {
    // 主表统计
    const mainStats = await pool().query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as last_7_days,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END) as last_30_days,
        MIN(created_at) as oldest,
        MAX(created_at) as newest
      FROM agent_messages 
      WHERE content_type = 'bitable_submission'
    `);
    
    // 归档表统计
    const archiveStats = await pool().query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END) as last_30_days
      FROM bitable_submissions_archive
    `);
    
    return {
      main: mainStats.rows[0] || {},
      archive: archiveStats.rows[0] || {},
      total: (mainStats.rows[0]?.total || 0) + (archiveStats.rows[0]?.total || 0)
    };
  } catch (e) {
    console.error('[bitable] get stats failed:', e?.message);
    return { main: {}, archive: {}, total: 0 };
  }
}

// ─────────────────────────────────────────────
// Bitable Integration for Checklist (continued)

const _bitableLastProcessedTime = new Map();
const _bitableProcessedRecordIds = new Set();
const BITABLE_DEDUP_MAX_KEYS = 30000;
const BITABLE_DEDUP_CLEAN_COUNT = 8000;
let _bitableDedupsSeeded = false;

// 启动时从数据库种子化dedup集合，避免重启后重复发送确认消息
async function seedBitableDedup() {
  if (_bitableDedupsSeeded) return;
  _bitableDedupsSeeded = true;
  try {
    const r = await pool().query(
      `SELECT DISTINCT record_id, table_id FROM feishu_generic_records WHERE created_at > NOW() - INTERVAL '30 days' LIMIT 50000`
    );
    for (const row of (r.rows || [])) {
      // 用通用 key 格式来匹配
      if (row.record_id) {
        // 尝试所有可能的 configKey 前缀
        for (const prefix of ['ops_checklist', 'table_visit_hongchao', 'table_visit_majixian', 'material_hongchao', 'material_majixian', 'meeting_reports', 'loss_reports']) {
          _bitableProcessedRecordIds.add(`${prefix}_${row.record_id}`);
        }
      }
    }
    console.log(`[bitable] seeded dedup set with ${_bitableProcessedRecordIds.size} keys from DB`);
  } catch (e) {
    console.error('[bitable] seed dedup failed:', e?.message);
  }
}

export async function pollBitableSubmissions(configKey = 'ops_checklist') {
  const cfg = BITABLE_CONFIGS[configKey];
  if (!cfg?.tableId) { return; } // skip configs without a valid tableId
  await seedBitableDedup();
  console.log(`[bitable][${configKey}] polling submissions...`);
  
  const records = [];
  let pageToken = '';
  let page = 0;
  while (page < 20) {
    const result = await getBitableRecords(configKey, { pageSize: 200, pageToken });
    if (!result.ok) {
      console.error(`[bitable][${configKey}] poll failed:`, result.error);
      return;
    }
    records.push(...(result.records || []));
    if (!result.hasMore || !result.nextPageToken) break;
    pageToken = result.nextPageToken;
    page += 1;
  }

  const newSubmissions = [];
  const newRecords = [];
  
  for (const record of records) {
    const recordId = record.record_id;
    const createdTime = record.created_time;
    const fields = record.fields || {};
    
    // 检查是否已处理过（使用 recordId 去重）
    const processedKey = `${configKey}_${recordId}`;
    if (_bitableProcessedRecordIds.has(processedKey)) {
      continue;
    }
    
    // 解析表单数据
    const submission = {
      configKey,
      recordId,
      createdTime,
      submitter: fields['提交人'] || '',
      store: fields['所属门店'] || '',
      checkType: fields['检查类型'] || '',
      checkStatus: fields['检查状态'] || '',
      checkRemark: fields['检查说明'] || '',
      checkPhotos: fields['检查照片'] || [],
      submitTime: fields['提交日期'] || createdTime,
      fields
    };
    
    console.log(`[bitable][${configKey}] new submission:`, submission);
    newSubmissions.push(submission);
    newRecords.push(record);
    
    // 标记为已处理
    _bitableProcessedRecordIds.add(processedKey);
    _bitableLastProcessedTime.set(processedKey, createdTime);
    
    // 限制内存中的记录数量
    if (_bitableProcessedRecordIds.size > BITABLE_DEDUP_MAX_KEYS) {
      const oldestIds = Array.from(_bitableProcessedRecordIds).slice(0, BITABLE_DEDUP_CLEAN_COUNT);
      oldestIds.forEach(id => {
        _bitableProcessedRecordIds.delete(id);
        _bitableLastProcessedTime.delete(id);
      });
      console.log('[bitable] cleaned up old processed records, current size:', _bitableProcessedRecordIds.size);
    }
  }
  
  if (newSubmissions.length > 0) {
    console.log(`[bitable][${configKey}] processed ${newSubmissions.length} new submissions`);

    // 统一写入 feishu_generic_records，确保 BI 可查询所有数据源
    const config = BITABLE_CONFIGS[configKey];
    for (const record of newRecords) {
      try {
        await pool().query(
          `INSERT INTO feishu_generic_records (app_token, table_id, record_id, fields, raw, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, NOW(), NOW())
           ON CONFLICT (app_token, table_id, record_id) DO UPDATE SET
             fields = EXCLUDED.fields, raw = EXCLUDED.raw, updated_at = NOW()`,
          [
            config?.appToken || '',
            config?.tableId || '',
            record.record_id,
            JSON.stringify(record.fields || {}),
            JSON.stringify(record)
          ]
        );
      } catch (e) {
        if (!String(e?.message || '').includes('duplicate')) {
          console.error(`[bitable][${configKey}] save generic record failed:`, e?.message);
        }
      }
    }

    // 知识图谱: 从新记录中抽取实体关系 (确定性规则, 零LLM成本)
    for (const record of newRecords) {
      try { await extractRelationsFromBitableRecord(record, configKey); } catch (e) {}
    }

    // 仅处理"本轮新增记录"，避免高量表每轮重复全量处理导致其它表饥饿
    await processBitableData(configKey, newRecords);
    
    // 如果是检查表类型，继续原有的确认消息逻辑
    if (configKey === 'ops_checklist') {
      // 处理每条提交记录
      for (const sub of newSubmissions) {
        // 1. 逻辑纠偏检查
        const logicValidation = await validateSubmissionLogic(sub);
        if (!logicValidation.isValid) {
          // 打回重拍
          if (sub.submitter && sub.submitter.id) {
            const rejectMessage = `❌ 提交被驳回\n${logicValidation.suggestion}\n请核实后重新提交。`;
            await sendLarkMessage(sub.submitter.id, prefixWithAgentName('ops_supervisor', rejectMessage));
            continue;
          }
        }
        
        // 2. 照片真实性验证
        let photoValidationResults = [];
        if (sub.checkPhotos && sub.checkPhotos.length > 0) {
          for (const photo of sub.checkPhotos) {
            if (photo.file_token) {
              const imageUrl = await getBitableRecordImageDownloadUrl(photo.file_token);
              if (imageUrl) {
                const validation = await validatePhotoAuthenticity(imageUrl, sub.store, sub.submitTime);
                photoValidationResults.push({
                  fileName: photo.name,
                  validation
                });
                
                // 如果照片不真实，直接拒绝
                if (!validation.isAuthentic) {
                  if (sub.submitter && sub.submitter.id) {
                    const rejectMessage = `🚫 照片验证失败\n检测到：${!validation.timeValid ? '时间异常' : ''}${!validation.notDuplicate ? '照片重复' : ''}${!validation.locationMatch ? '地点不符' : ''}\n请重新拍摄真实照片。`;
                    await sendLarkMessage(sub.submitter.id, prefixWithAgentName('ops_supervisor', rejectMessage));
                  }
                  continue;
                }
              }
            }
          }
        }
        
        // 3. 图片识别分析
        let visionResults = [];
        if (sub.checkPhotos && sub.checkPhotos.length > 0) {
          console.log(`[bitable] processing ${sub.checkPhotos.length} photos for record ${sub.recordId}`);
          
          for (const photo of sub.checkPhotos) {
            if (photo.file_token) {
              const imageUrl = await getBitableRecordImageDownloadUrl(photo.file_token);
              if (imageUrl) {
                try {
                  const visionResult = await callVisionLLM([
                    { type: 'image', image_url: imageUrl },
                    { type: 'text', text: `请检查这张餐厅${sub.checkType}照片，评估：1.卫生状况 2.安全规范 3.整体状态。给出评分(1-10分)和具体问题。` }
                  ]);
                  
                  visionResults.push({
                    fileName: photo.name,
                    result: visionResult.content || '识别失败',
                    score: extractScore(visionResult.content) || 0
                  });
                  
                  console.log(`[bitable] vision result for ${photo.name}:`, visionResult.content?.substring(0, 100) + '...');
                } catch (e) {
                  console.error(`[bitable] vision analysis failed for ${photo.file_token}:`, e?.message);
                  visionResults.push({
                    fileName: photo.name,
                    result: '图片识别失败',
                    score: 0
                  });
                }
              }
            }
          }
        }
        
        // 4. 构建确认消息
        let reply = `✅ 已收到你的${sub.checkType}提交\n门店：${sub.store}\n状态：${sub.checkStatus}\n说明：${sub.checkRemark}\n照片：${sub.checkPhotos.length}张\n提交时间：${new Date(sub.submitTime).toLocaleString()}\n`;
        
        // 添加照片验证结果
        if (photoValidationResults.length > 0) {
          reply += `\n🔍 照片验证：全部通过真实性检查`;
        }
        
        // 添加图片识别结果
        if (visionResults.length > 0) {
          const avgScore = visionResults.reduce((sum, r) => sum + r.score, 0) / visionResults.length;
          reply += `\n\n🎯 图片识别结果：\n平均评分：${avgScore.toFixed(1)}/10`;
          visionResults.forEach((r, i) => {
            reply += `\n${i + 1}. ${r.fileName}：${r.score}/10 - ${r.result.substring(0, 30)}...`;
          });
        }
        
        reply += `\n\n系统已记录，感谢配合！`;
        
        // 5. 存储识别结果到数据库（添加去重检查）
        try {
          const messageKey = `${sub.submitter.id}-${sub.recordId}-vision_analysis`;
          if (!deduplicateMessage(messageKey, 'system')) {
            console.log('[bitable] vision analysis message deduplicated');
          } else {
            await pool().query(
              `INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, sender_role, routed_to, content_type, content, agent_data)
               VALUES ('out','feishu',$1,$2,$3,$4,'ops_supervisor','vision_analysis',$5,$6::jsonb)`,
              [sub.submitter.id, sub.submitter.name || sub.submitter.id, sub.submitter.name || sub.submitter.id, '', 
               `${sub.checkType}图片识别分析`, JSON.stringify({ recordId: sub.recordId, visionResults, photoValidationResults, avgScore: visionResults.reduce((sum, r) => sum + r.score, 0) / visionResults.length })]
            );
          }
        } catch (e) {}
        
        // 6. 存储结构化数据到本地数据库
        try {
          await pool().query(
            `INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, sender_role, routed_to, content_type, content, agent_data)
             VALUES ('in','feishu',$1,$2,$3,$4,'ops_supervisor','bitable_submission',$5,$6::jsonb)`,
            [sub.submitter.id, sub.submitter.name || sub.submitter.id, sub.submitter.name || sub.submitter.id, '', 
             `${sub.checkType}提交（Bitable）`, JSON.stringify(submission)]
          );
        } catch (e) {}
        
        // 7. 发送确认消息
        await sendLarkMessage(sub.submitter.id, prefixWithAgentName('ops_supervisor', reply));
      }
    }
  }
}

// 多配置轮询调度器
export async function pollAllBitableSubmissions() {
  const preferredOrder = [
    'ops_checklist',
    'bad_reviews',
    'closing_reports',
    'opening_reports',
    'meeting_reports',
    'material_majixian',
    'material_hongchao',
    'table_visit'
  ];
  const known = new Set(preferredOrder);
  const finalKeys = [
    ...preferredOrder.filter((k) => BITABLE_CONFIGS[k]),
    ...Object.keys(BITABLE_CONFIGS).filter((k) => !known.has(k) && BITABLE_CONFIGS[k]?.type !== 'task_response')
  ];
  for (const configKey of finalKeys) {
    try {
      await pollBitableSubmissions(configKey);
    } catch (e) {
      console.error(`[bitable][${configKey}] poll error:`, e?.message);
    }
  }
}

// ─────────────────────────────────────────────
// Task Response via Bitable Collection Form
// ─────────────────────────────────────────────
const _taskResponseBitableState = { tableId: '', formViewId: '', formUrl: '', initialized: false, failCount: 0, disabled: false };
const _processedTaskResponseIds = new Set();

const TASK_RESPONSE_TABLE_NAME = '异常任务回复';
const TASK_RESPONSE_FIELDS = [
  { field_name: '任务编号', type: 1 },
  { field_name: '异常类型', type: 1 },
  { field_name: '门店', type: 1 },
  { field_name: '品牌', type: 1 },
  { field_name: '严重程度', type: 1 },
  { field_name: '异常描述', type: 1 },
  { field_name: '回复说明', type: 1 },
  { field_name: '整改照片', type: 17 },
  { field_name: '处理状态', type: 3, property: { options: [{ name: '待回复' }, { name: '已回复' }, { name: '已处理' }] } }
];

export async function ensureTaskResponseBitable() {
  if (_taskResponseBitableState.initialized && _taskResponseBitableState.tableId) return true;
  if (_taskResponseBitableState.disabled) return false; // permanently failed, stop retrying

  const configKey = 'task_responses';
  const config = BITABLE_CONFIGS[configKey];

  // If table_id is set via env var, use directly
  if (config?.tableId) {
    _taskResponseBitableState.tableId = config.tableId;
    _taskResponseBitableState.initialized = true;
    console.log('[task_response] Using configured table:', config.tableId);
    await _ensureTaskResponseFormView(configKey);
    return true;
  }

  const token = await getBitableTenantToken(configKey);
  if (!token) { console.error('[task_response] No tenant token'); return false; }

  try {
    // Skip list-tables (requires permissions we may not have) — go straight to create
    const createResp = await axios.post(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables`,
      { table: { name: TASK_RESPONSE_TABLE_NAME, default_view_name: '默认视图', fields: TASK_RESPONSE_FIELDS } },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const newId = createResp.data?.data?.table_id;
    if (!newId) { console.error('[task_response] Table creation returned no ID:', createResp.data); return false; }
    _taskResponseBitableState.tableId = newId;
    config.tableId = newId;
    _taskResponseBitableState.failCount = 0;
    console.log('[task_response] Created new table:', newId);

    await _ensureTaskResponseFormView(configKey);
    _taskResponseBitableState.initialized = true;
    return true;
  } catch (e) {
    _taskResponseBitableState.failCount++;
    const errCode = e?.response?.data?.code;
    const errMsg = e?.response?.data?.msg || e?.message;
    if (_taskResponseBitableState.failCount <= 2) {
      console.error(`[task_response] ensureTaskResponseBitable failed (${_taskResponseBitableState.failCount}/3): code=${errCode} msg=${errMsg}`);
    }
    // After 3 failures, disable permanently to stop log spam
    if (_taskResponseBitableState.failCount >= 3) {
      if (errCode === 1254302) {
        console.error('[task_response] ⚠️ Feishu app lacks bitable:app permission — Bitable task response DISABLED. Tasks will still be sent via Feishu messages. To enable: grant permission in Feishu Developer Console or set BITABLE_TASK_RESP_TABLE_ID env var.');
      } else {
        console.error(`[task_response] Bitable task response DISABLED after 3 failures. Last error: code=${errCode} msg=${errMsg}`);
      }
      _taskResponseBitableState.disabled = true;
    }
    return false;
  }
}

async function _ensureTaskResponseFormView(configKey) {
  const config = BITABLE_CONFIGS[configKey];
  const tableId = _taskResponseBitableState.tableId;
  if (!tableId) return;

  const envFormUrl = process.env.BITABLE_TASK_RESP_FORM_URL || 'https://qcniocx2wuu8.feishu.cn/base/BTAjbflrlaMRHesADUfc8usznqh?table=tblT86H1uuTJydne&view=vewOvsJql9';
  if (envFormUrl) {
    _taskResponseBitableState.formUrl = envFormUrl;
    console.log('[task_response] Using form URL from env:', envFormUrl);
    return;
  }

  const host = String(process.env.BITABLE_TASK_RESP_HOST || 'qcniocx2wuu8.feishu.cn').trim() || 'qcniocx2wuu8.feishu.cn';
  const forcedViewId = String(process.env.BITABLE_TASK_RESP_VIEW_ID || 'vewOvsJql9').trim();
  if (forcedViewId) {
    _taskResponseBitableState.formViewId = forcedViewId;
    _taskResponseBitableState.formUrl = `https://${host}/base/${config.appToken}?table=${tableId}&view=${forcedViewId}`;
    console.log('[task_response] Using view ID from env, form URL:', _taskResponseBitableState.formUrl);
    return;
  }

  const token = await getBitableTenantToken(configKey);
  if (!token) return;

  try {
    const viewsResp = await axios.get(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${tableId}/views`,
      { headers: { 'Authorization': `Bearer ${token}` }, timeout: 10000 }
    );
    const views = viewsResp.data?.data?.items || [];
    let formView = views.find(v => v.view_type === 'form');

    if (!formView) {
      try {
        const cvResp = await axios.post(
          `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${tableId}/views`,
          { view_name: '任务回复表单', view_type: 'form' },
          { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        formView = cvResp.data?.data?.view || null;
      } catch (e) {
        console.log('[task_response] Could not create form view:', e?.response?.data?.msg || e?.message);
      }
    }

    const viewId = formView?.view_id || _taskResponseBitableState.formViewId;
    if (viewId) {
      _taskResponseBitableState.formViewId = viewId;
      _taskResponseBitableState.formUrl = `https://${host}/base/${config.appToken}?table=${tableId}&view=${viewId}`;
    } else {
      _taskResponseBitableState.formUrl = `https://${host}/base/${config.appToken}?table=${tableId}`;
    }
    console.log('[task_response] Form URL:', _taskResponseBitableState.formUrl);
  } catch (e) {
    _taskResponseBitableState.formUrl = `https://${host}/base/${config.appToken}?table=${tableId}`;
    console.log('[task_response] Fallback to table URL:', _taskResponseBitableState.formUrl);
  }
}

export async function createBitableRecord(configKey, fields) {
  const config = BITABLE_CONFIGS[configKey];
  if (!config?.tableId) { console.error(`[bitable] createBitableRecord: no table_id for ${configKey}`); return null; }

  const token = await getBitableTenantToken(configKey);
  if (!token) return null;

  try {
    const resp = await axios.post(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records`,
      { fields },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    const record = resp.data?.data?.record;
    if (!record?.record_id) {
      console.warn(`[bitable][${configKey}] createBitableRecord: no record_id in response. code=${resp.data?.code} msg=${resp.data?.msg} keys=${Object.keys(resp.data?.data || {}).join(',')}`);
    } else {
      console.log(`[bitable][${configKey}] created record: ${record.record_id}`);
    }
    return record;
  } catch (e) {
    console.error(`[bitable][${configKey}] createBitableRecord failed:`, e?.response?.data || e?.message);
    return null;
  }
}

export async function updateBitableRecord(configKey, recordId, fields) {
  const config = BITABLE_CONFIGS[configKey];
  if (!config?.tableId) return null;

  const token = await getBitableTenantToken(configKey);
  if (!token) return null;

  try {
    const resp = await axios.put(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records/${recordId}`,
      { fields },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    return resp.data?.data?.record || null;
  } catch (e) {
    console.error(`[bitable][${configKey}] updateBitableRecord failed:`, e?.response?.data || e?.message);
    return null;
  }
}

export async function writeTaskToBitable(task) {
  const ready = await ensureTaskResponseBitable();
  if (!ready) { console.warn('[task_response] Bitable not ready, skipping write'); return null; }

  const fields = {
    '任务编号': String(task.task_id || ''),
    '异常类型': String(task.category || ''),
    '门店': String(task.store || ''),
    '品牌': String(task.brand || ''),
    '严重程度': String(task.severity || 'medium'),
    '异常描述': String(task.title || '') + (task.detail ? '\n' + task.detail : ''),
    '回复说明': '',
    '处理状态': '待回复'
  };

  const record = await createBitableRecord('task_responses', fields);
  if (record) {
    _processedTaskResponseIds.add(`task_responses_${record.record_id}`);
  }
  return record;
}

export function getTaskResponseFormUrl(task) {
  const baseUrl = _taskResponseBitableState.formUrl;
  if (!baseUrl) return '';

  const params = new URLSearchParams();
  if (task?.task_id) params.set('prefill_任务编号', task.task_id);
  if (task?.category) params.set('prefill_异常类型', task.category);
  if (task?.store) params.set('prefill_门店', task.store);
  if (task?.brand) params.set('prefill_品牌', task.brand);
  if (task?.severity) params.set('prefill_严重程度', task.severity);
  const desc = String(task?.title || '') + (task?.detail ? '\n' + task.detail : '');
  if (desc.trim()) params.set('prefill_异常描述', desc.trim().slice(0, 500));

  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}${params.toString()}`;
}

export function buildTaskDispatchCard(task, formUrl, { isFirstDispatch = true } = {}) {
  const sev = task.severity === 'high' ? '🔴 高' : '🟡 中';
  const roleLabel = task.assignee_role === 'store_production_manager' ? '出品经理' : '店长';
  const timeNow = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const newBadge = isFirstDispatch ? '🆕 新任务 · ' : '🔄 追踪 · ';

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${newBadge}⚠️ 异常通知 [${task.task_id}]` },
      template: isFirstDispatch ? (task.severity === 'high' ? 'red' : 'orange') : 'blue'
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**门店**\n${task.store || '-'}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**品牌**\n${task.brand || '-'}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**严重程度**\n${sev}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**时间**\n${timeNow}` } }
        ]
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**异常类型**：${task.category || '-'}\n\n**详情**：${task.title || '-'}\n${task.detail || ''}` }
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `${roleLabel}您好，请点击下方按钮打开回复表单，说明原因并提交整改措施：` }
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📝 填写回复表单' },
            type: 'primary',
            url: formUrl
          }
        ]
      },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: `任务编号：${task.task_id} · 请在表单中填写回复说明和上传整改照片 · 小年` }
        ]
      }
    ]
  };
}

export async function pollTaskResponseBitable() {
  const ready = await ensureTaskResponseBitable();
  if (!ready) return;

  console.log('[task_response] polling for responses...');

  try {
    const result = await getBitableRecords('task_responses', { pageSize: 50 });
    if (!result.ok) { console.error('[task_response] poll failed:', result.error); return; }

    const records = result.records || [];
    let processed = 0;

    for (const record of records) {
      const recordId = record.record_id;
      const fields = record.fields || {};
      const processedKey = `task_responses_${recordId}`;

      if (_processedTaskResponseIds.has(processedKey)) continue;

      const taskId = extractBitableFieldText(fields['任务编号']);
      const responseText = extractBitableFieldText(fields['回复说明']);
      const status = extractBitableFieldText(fields['处理状态']);

      // Only process records with a response that haven't been processed yet
      if (!taskId || !responseText || status === '已处理') {
        _processedTaskResponseIds.add(processedKey);
        continue;
      }

      console.log(`[task_response] Found response for task ${taskId}: ${responseText.slice(0, 80)}...`);

      try {
        const taskResult = await pool().query(
          `SELECT * FROM master_tasks WHERE task_id = $1 AND status = 'pending_response' LIMIT 1`,
          [taskId]
        );
        const task = taskResult.rows?.[0];

        if (!task) {
          console.log(`[task_response] Task ${taskId} not found or not in pending_response`);
          _processedTaskResponseIds.add(processedKey);
          continue;
        }

        // Extract photo URLs if any
        const photos = fields['整改照片'];
        const photoUrls = [];
        if (Array.isArray(photos)) {
          for (const p of photos) {
            if (p?.file_token) {
              const url = await getBitableRecordImageDownloadUrl('task_responses', p.file_token);
              if (url) photoUrls.push(url);
            }
          }
        }

        // Use the task response hook (set by master-agent.js)
        if (_taskResponseHook) {
          await _taskResponseHook(task.assignee_username, responseText, photoUrls);
        } else {
          // Direct DB update fallback
          await pool().query(
            `UPDATE master_tasks SET response_text = $1, response_images = $2::jsonb, status = 'pending_review', responded_at = NOW(), updated_at = NOW() WHERE task_id = $3`,
            [responseText, JSON.stringify(photoUrls), taskId]
          );
        }

        // Update Bitable record status
        await updateBitableRecord('task_responses', recordId, { '处理状态': '已处理' });
        processed++;
        console.log(`[task_response] Processed response for ${taskId}`);
      } catch (e) {
        console.error(`[task_response] Error processing ${taskId}:`, e?.message);
      }

      _processedTaskResponseIds.add(processedKey);
    }

    if (processed > 0) console.log(`[task_response] Processed ${processed} new responses`);

    // Cleanup processed set if too large
    if (_processedTaskResponseIds.size > 5000) {
      const old = Array.from(_processedTaskResponseIds).slice(0, 2000);
      old.forEach(k => _processedTaskResponseIds.delete(k));
    }
  } catch (e) {
    console.error('[task_response] poll error:', e?.message);
  }
}

// 导出定时任务函数
export { startScheduledTasks };

// ─────────────────────────────────────────────
// 定时任务调度器
// ─────────────────────────────────────────────

const DEFAULT_SCHEDULED_TASKS = {
  
};

let _scheduledTaskIntervals = new Map();
const _scheduledTaskRuntimeStatus = new Map();

function buildScheduledTasksFromConfig() {
  const runtime = {};
  const inspections = Array.isArray(OPS_AGENT_CONFIG?.scheduledTasks?.dailyInspections)
    ? OPS_AGENT_CONFIG.scheduledTasks.dailyInspections
    : [];
  const randomInspections = Array.isArray(OPS_AGENT_CONFIG?.scheduledTasks?.randomInspections)
    ? OPS_AGENT_CONFIG.scheduledTasks.randomInspections
    : [];

  for (const inspection of inspections) {
    const store = String(inspection?.store || '').trim();
    const brand = String(inspection?.brand || '').trim();
    const type = String(inspection?.type || '').trim();
    const time = String(inspection?.time || '').trim();
    const timeWindow = Math.max(5, Math.floor(Number(inspection?.timeWindow) || 60));
    if (!type || !time || (!brand && !store)) continue;
    const identity = store || brand;
    const key = `${identity}_${type === 'opening' ? '开市' : type === 'closing' ? '收档' : type}`;
    runtime[key] = {
      store,
      time,
      frequency: String(inspection?.frequency || 'daily').trim(),
      customIntervalDays: Math.max(1, Math.floor(Number(inspection?.customIntervalDays) || 1)),
      action: 'send_checklist',
      brand,
      timeWindow,
      checkType: type
    };
  }

  for (let i = 0; i < randomInspections.length; i += 1) {
    const inspection = randomInspections[i] || {};
    const type = String(inspection?.type || '').trim();
    if (!type) continue;
    const store = String(inspection?.store || '').trim();
    const brand = String(inspection?.brand || '').trim();
    const minH = Math.max(1, Math.floor(Number(inspection?.intervalMinHours) || Number(inspection?.interval?.[0]) || 2));
    const maxH = Math.max(minH, Math.floor(Number(inspection?.intervalMaxHours) || Number(inspection?.interval?.[1]) || 4));
    const key = `随机抽检_${store || brand || '全门店'}_${type}_${i + 1}`;
    runtime[key] = {
      random: true,
      interval: [minH, maxH],
      action: 'safety_check',
      type,
      description: String(inspection?.description || '食安抽检').trim(),
      timeWindow: Math.max(1, Math.floor(Number(inspection?.timeWindow) || 15)),
      store,
      brand,
      assigneeRoles: Array.isArray(inspection?.assigneeRoles) && inspection.assigneeRoles.length
        ? inspection.assigneeRoles.map((r) => String(r || '').trim()).filter(Boolean)
        : ['store_manager', 'store_production_manager']
    };
  }

  if (Object.keys(runtime).length === 0) {
    // 仅当没有任何显式配置时才使用默认值（首次启动且DB无配置）
    // 如果配置中心已保存过配置（哪怕是空数组），尊重用户设置
    const hasExplicitDailyConfig = Array.isArray(OPS_AGENT_CONFIG?.scheduledTasks?.dailyInspections);
    const hasExplicitRandomConfig = Array.isArray(OPS_AGENT_CONFIG?.scheduledTasks?.randomInspections);
    const dailyLen = hasExplicitDailyConfig ? OPS_AGENT_CONFIG.scheduledTasks.dailyInspections.length : -1;
    const randomLen = hasExplicitRandomConfig ? OPS_AGENT_CONFIG.scheduledTasks.randomInspections.length : -1;
    // 如果两个数组都存在且都为空 → 用户主动清空了所有任务
    if (dailyLen === 0 && randomLen === 0) {
      console.log('[ops] All scheduled tasks cleared by user configuration');
      return {};
    }
    // 如果数组存在但产出0个有效key（例如随机任务的type为空），也尊重配置
    if (hasExplicitDailyConfig || hasExplicitRandomConfig) {
      console.log('[ops] No valid scheduled tasks produced from configuration (daily:', dailyLen, 'random:', randomLen, ')');
      return {};
    }
    // 真正没有配置时才使用默认值
    console.log('[ops] No configuration found, using default scheduled tasks');
    return { ...DEFAULT_SCHEDULED_TASKS };
  }
  return runtime;
}

function getInspectionIntervalDays(config) {
  const frequency = String(config?.frequency || 'daily').trim();
  if (frequency === 'weekly') return 7;
  if (frequency === 'biweekly') return 14;
  if (frequency === 'monthly') return 30;
  if (frequency === 'custom') return Math.max(1, Math.floor(Number(config?.customIntervalDays) || 1));
  return 1;
}

export function getScheduledTaskStatus() {
  const tasks = Array.from(_scheduledTaskRuntimeStatus.entries()).map(([taskKey, status]) => ({
    taskKey,
    ...status
  }));
  return {
    started: _scheduledTaskIntervals.size > 0,
    activeTimers: _scheduledTaskIntervals.size,
    tasks
  };
}

async function startScheduledTasks() {
  console.log('[ops] starting scheduled tasks...');
  await refreshOpsAgentRuntimeConfig();
  const runtimeTasks = buildScheduledTasksFromConfig();
  
  // 清除现有定时器
  for (const [, timer] of _scheduledTaskIntervals) {
    clearTimeout(timer);
  }
  _scheduledTaskIntervals.clear();
  _scheduledTaskRuntimeStatus.clear();
  
  // 设置定时任务
  for (const [taskKey, config] of Object.entries(runtimeTasks)) {
    _scheduledTaskRuntimeStatus.set(taskKey, {
      taskKey,
      action: config.action,
      nextExecutionAt: null,
      lastRunAt: null,
      runCount: 0,
      lastError: null
    });
    if (config.random) {
      // 随机任务
      scheduleRandomTask(taskKey, config);
    } else {
      // 定时任务
      scheduleFixedTask(taskKey, config);
    }
  }
}

function scheduleFixedTask(taskKey, config) {
  const [hour, minute] = config.time.split(':').map(Number);
  const intervalDays = getInspectionIntervalDays(config);

  const scheduleNext = () => {
    const now = new Date();
    const nextExecution = new Date(now);
    nextExecution.setHours(hour);
    nextExecution.setMinutes(minute);
    nextExecution.setSeconds(0);
    nextExecution.setMilliseconds(0);
    
    // 如果今天时间已过，按频率顺延
    if (nextExecution <= now) {
      nextExecution.setDate(nextExecution.getDate() + intervalDays);
    }
    
    const msUntilExecution = nextExecution.getTime() - now.getTime();
    const status = _scheduledTaskRuntimeStatus.get(taskKey);
    if (status) {
      status.nextExecutionAt = nextExecution.toISOString();
      _scheduledTaskRuntimeStatus.set(taskKey, status);
    }
    
    const timer = setTimeout(() => {
      executeScheduledTask(taskKey, config);
      scheduleNext(); // 递归调度下一次
    }, msUntilExecution);
    _scheduledTaskIntervals.set(taskKey, timer);
    
    console.log(`[ops] scheduled ${taskKey} for: ${nextExecution.toISOString()}`);
  };
  
  scheduleNext();
}

function scheduleRandomTask(taskKey, config) {
  const [minHours, maxHours] = config.interval;
  
  const scheduleNext = () => {
    const intervalHours = minHours + Math.random() * (maxHours - minHours);
    let nextExecution = new Date(Date.now() + intervalHours * 3600000);
    // 确保在工作时间10:00-20:00 CST内执行，否则推到次日10:00+随机偏移
    const cstH = Number(nextExecution.toLocaleString('en-US',{timeZone:'Asia/Shanghai',hour:'numeric',hour12:false}));
    if (cstH < 10 || cstH >= 20) {
      const adj = new Date(nextExecution); adj.setMinutes(0); adj.setSeconds(0);
      adj.setHours(adj.getHours() + (cstH >= 20 ? (24 - cstH + 10) : (10 - cstH)));
      nextExecution = new Date(adj.getTime() + Math.random() * 6 * 3600000);
    }
    const intervalMs = nextExecution.getTime() - Date.now();
    const status = _scheduledTaskRuntimeStatus.get(taskKey);
    if (status) {
      status.nextExecutionAt = nextExecution.toISOString();
      _scheduledTaskRuntimeStatus.set(taskKey, status);
    }
    
    const timer = setTimeout(() => {
      executeScheduledTask(taskKey, config);
      scheduleNext(); // 递归调度下一次
    }, intervalMs);
    _scheduledTaskIntervals.set(taskKey, timer);
    
    console.log(`[ops] scheduled random ${taskKey} for: ${nextExecution.toISOString()} (interval: ${intervalHours}h)`);
  };
  
  scheduleNext();
}

function isWithinWorkingHours() {
  const now = new Date();
  const hour = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false }));
  return hour >= 10 && hour <= 20;
}

async function executeScheduledTask(taskKey, config) {
  if (!isWithinWorkingHours()) {
    console.log(`[ops] skipping task ${taskKey}: outside working hours (10:00-21:00 CST)`);
    return;
  }
  console.log(`[ops] executing scheduled task: ${taskKey}`);
  const status = _scheduledTaskRuntimeStatus.get(taskKey) || {
    taskKey,
    action: config?.action || '',
    nextExecutionAt: null,
    lastRunAt: null,
    runCount: 0,
    lastError: null
  };
  status.lastRunAt = new Date().toISOString();
  status.runCount = Number(status.runCount || 0) + 1;
  status.lastError = null;
  
  try {
    switch (config.action) {
      case 'send_checklist':
        await sendScheduledChecklist(config);
        break;
      case 'safety_check':
        await sendSafetyCheck(config);
        break;
      default:
        console.log(`[ops] unknown task action: ${config.action}`);
    }
  } catch (e) {
    status.lastError = String(e?.message || e);
    console.error(`[ops] scheduled task ${taskKey} failed:`, e?.message);
  } finally {
    _scheduledTaskRuntimeStatus.set(taskKey, status);
  }
}

export async function sendScheduledChecklist(config) {
  // 优先按门店发送；未配置门店时，按品牌发送
  const sharedState = await getSharedState();
  const stores = Object.entries(sharedState.stores || {});
  const configStore = String(config?.store || '').trim();
  const configBrand = String(config?.brand || '').trim();
  const targetStores = configStore
    ? stores.filter(([, s]) => isLikelySameStore(s?.name, configStore))
    : stores.filter(([, s]) => String(s?.brand || '').trim() === configBrand);
  
  if (targetStores.length === 0) {
    console.log(`[ops] no stores found for config: store=${configStore}, brand=${configBrand}`);
    return;
  }
  
  // 提取所有员工信息以寻找店长和出品经理
  const allStaff = [
    ...(Array.isArray(sharedState.employees) ? sharedState.employees : []),
    ...(Array.isArray(sharedState.users) ? sharedState.users : [])
  ];

  // 向每个门店发送检查表
  for (const [storeKey, store] of targetStores) {
    try {
      // 同时查找该门店的 店长(store_manager) 和 出品经理(store_production_manager)
      const targets = allStaff.filter(u =>
        normalizeStoreKey(u?.store) === normalizeStoreKey(store.name) &&
        (u.role === 'store_manager' || u.role === 'store_production_manager')
      );
      const uniqueUsernames = [...new Set(targets.map(u => String(u.username || '').trim()).filter(Boolean))];
      
      for (const username of uniqueUsernames) {
        const feishuUser = await lookupFeishuUserByUsername(username);
        if (feishuUser?.open_id) {
          const DEFAULT_FORM_URLS = {
            opening: 'https://ycnp8e71t8x8.feishu.cn/base/PtVObRtoPaMAP3stIIFc8DnJngd?table=tblxHI9ZAKONOTpp&view=vewjuqywQu',
            closing: 'https://ycnp8e71t8x8.feishu.cn/base/PtVObRtoPaMAP3stIIFc8DnJngd?table=tblxHI9ZAKONOTpp&view=vewjuqywQu'
          };
          const formUrl = String(config.formUrl || '').trim() || DEFAULT_FORM_URLS[config.checkType] || '';
          const typeLabel = formatChecklistTypeLabel(config.checkType);
          const headerColor = config.checkType === 'closing' ? 'orange' : 'blue';
          const timeNow = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          const timeWindow = Math.max(5, Math.floor(Number(config?.timeWindow) || 60));
          const deadlineAt = new Date(Date.now() + timeWindow * 60 * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          
          const infoFields = [
            { is_short: true, text: { tag: 'lark_md', content: `**门店**\n${store.name}` } },
            { is_short: true, text: { tag: 'lark_md', content: `**品牌**\n${configBrand || store?.brand || '-'}` } },
            { is_short: true, text: { tag: 'lark_md', content: `**检查类型**\n${typeLabel}检查` } },
            { is_short: true, text: { tag: 'lark_md', content: `**发送时间**\n${timeNow}` } },
            { is_short: true, text: { tag: 'lark_md', content: `**完成时限**\n${timeWindow}分钟` } },
            { is_short: true, text: { tag: 'lark_md', content: `**截止时间**\n${deadlineAt}` } }
          ];
          
          const elements = [{ tag: 'div', fields: infoFields }, { tag: 'hr' }];
          
          if (formUrl) {
            elements.push({ tag: 'div', text: { tag: 'lark_md', content: '请点击下方按钮打开检查表，逐项检查并提交：' } });
            elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '📝 打开检查表' }, type: 'primary', url: formUrl }] });
          } else {
            const items = getOpsChecklistItems(config.checkType, store.name, configBrand);
            const listMd = items.length
              ? items.map((it, i) => `${i+1}. ${it}`).join('\n')
              : '请在现场完成巡检并通过聊天窗口回复检查结果（文字+照片）';
            elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**检查项目：**\n${listMd}` } });
            elements.push({ tag: 'div', text: { tag: 'lark_md', content: '\n💡 请直接在聊天中回复检查结果（可附照片），小年将自动记录。' } });
          }
          elements.push({ tag: 'hr' });
          elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `请在截止时间前完成提交 · 小年` }] });
          
          const card = {
            config: { wide_screen_mode: true },
            header: { title: { tag: 'plain_text', content: `📋 ${typeLabel}检查通知` }, template: headerColor },
            elements
          };
          
          const cardResult = await sendLarkCard(feishuUser.open_id, card);
          if (cardResult.ok) {
            console.log(`[ops] sent scheduled checklist to ${store.name} (${username})`);
          }
        }
      }
    } catch (e) {
      console.error(`[ops] failed to send checklist to ${storeKey}:`, e?.message);
    }
  }
}

async function sendSafetyCheck(config) {
  const sharedState = await getSharedState();
  const stores = Object.entries(sharedState.stores || {});

  if (!stores.length) {
    console.log('[ops] no stores available for safety check');
    return;
  }

  const configStore = String(config?.store || '').trim();
  const configBrand = String(config?.brand || '').trim();
  const targetStores = configStore
    ? stores.filter(([, s]) => isLikelySameStore(s?.name, configStore))
    : (configBrand ? stores.filter(([, s]) => String(s?.brand || '').trim() === configBrand) : stores);
  if (!targetStores.length) {
    console.log(`[ops] no stores matched safety check config: store=${configStore}, brand=${configBrand}`);
    return;
  }

  const [, pickedStore] = targetStores[Math.floor(Math.random() * targetStores.length)];
  const roles = Array.isArray(config?.assigneeRoles) && config.assigneeRoles.length
    ? config.assigneeRoles.map((r) => String(r || '').trim()).filter(Boolean)
    : ['store_manager', 'store_production_manager'];
  const allStaff = [
    ...(Array.isArray(sharedState.employees) ? sharedState.employees : []),
    ...(Array.isArray(sharedState.users) ? sharedState.users : [])
  ];
  const assignees = allStaff.filter((u) =>
    normalizeStoreKey(u?.store) === normalizeStoreKey(pickedStore?.name) &&
    roles.includes(String(u?.role || '').trim())
  );
  const usernames = [...new Set(assignees.map((u) => String(u?.username || '').trim()).filter(Boolean))];

  const taskDesc = String(config?.description || '').trim() || '请完成本次食安抽检';
  const timeWindow = Math.max(1, Math.floor(Number(config?.timeWindow) || 15));
  const taskType = String(config?.type || '').trim() || '食安抽检';
  const timeNow = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const deadlineAt = new Date(Date.now() + timeWindow * 60 * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const message = `🔔 随机抽检通知\n\n门店：${pickedStore?.name || '-'}\n类型：${taskType}\n任务：${taskDesc}\n时间：${timeNow}\n时限：${timeWindow}分钟内完成\n截止：${deadlineAt}\n\n请拍照发送至本对话。`;
  const safetyCard = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `🔔 随机抽检 · ${taskType}` }, template: 'yellow' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**门店**：${pickedStore?.name || '-'}\n**类型**：${taskType}\n**任务**：${taskDesc}` } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**时间**：${timeNow}\n**时限**：${timeWindow}分钟内完成\n**截止**：${deadlineAt}` } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '📸 请拍照发送至本对话。' } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `小年 · ${taskType}` }] }
    ]
  };

  if (!usernames.length) {
    const fallbackUser = await lookupFeishuUserByUsername(String(pickedStore?.manager || '').trim());
    if (!fallbackUser?.open_id) {
      console.log(`[ops] no assignee found for safety check: store=${pickedStore?.name || '-'}, roles=${roles.join(',')}`);
      return;
    }
    let r = await sendLarkCard(fallbackUser.open_id, safetyCard);
    if (!r.ok) await sendLarkMessage(fallbackUser.open_id, prefixWithAgentName('ops_supervisor', message));
    console.log(`[ops] sent safety check to fallback manager of ${pickedStore?.name || '-'}: ${taskType} - ${taskDesc}`);
    return;
  }

  for (const username of usernames) {
    const feishuUser = await lookupFeishuUserByUsername(username);
    if (!feishuUser?.open_id) continue;
    let r = await sendLarkCard(feishuUser.open_id, safetyCard);
    if (!r.ok) await sendLarkMessage(feishuUser.open_id, prefixWithAgentName('ops_supervisor', message));
  }
  console.log(`[ops] sent safety check to ${pickedStore?.name || '-'} (${usernames.join(',')}): ${taskType} - ${taskDesc}`);
}

// 辅助函数：从AI回复中提取分数
function extractScore(text) {
  if (!text) return 0;
  const match = text.match(/(\d+(?:\.\d+)?)\s*\/\s*10|评分[：:]\s*(\d+(?:\d+)?)/i);
  return match ? parseFloat(match[1] || match[2]) : 0;
}

// 照片真实性验证
async function validatePhotoAuthenticity(imageUrl, expectedLocation, submitTime) {
  console.log('[ops] validating photo authenticity...');
  
  try {
    // 1. 调用视觉 AI 分析照片内容
    const visionResult = await callVisionLLM([
      { type: 'image', image_url: imageUrl },
      { type: 'text', text: `请分析这张照片：1.拍摄地点是否为${expectedLocation} 2.照片中的环境特征 3.是否有时间显示 4.照片真实性评估` }
    ]);
    
    // 2. 模拟 EXIF 和 GPS 验证（实际需要更复杂的实现）
    const now = Date.now();
    const timeDiff = Math.abs(now - submitTime);
    const isTimeValid = timeDiff < 5 * 60 * 1000; // 5分钟内
    
    // 3. 照片 Hash 简单验证（实际需要更复杂的实现）
    const photoHash = imageUrl.split('/').pop(); // 简化实现
    const isDuplicate = await checkPhotoDuplicate(photoHash);
    
    const validation = {
      isAuthentic: isTimeValid && !isDuplicate,
      timeValid: isTimeValid,
      notDuplicate: !isDuplicate,
      locationMatch: visionResult.content?.includes(expectedLocation) || false,
      confidence: 0.8 // 简化实现
    };
    
    console.log('[ops] photo validation result:', validation);
    return validation;
  } catch (e) {
    console.error('[ops] photo validation failed:', e?.message);
    return { isAuthentic: false, error: e?.message };
  }
}

// 检查照片重复
async function checkPhotoDuplicate(photoHash) {
  try {
    const result = await pool().query(
      'SELECT COUNT(*) as count FROM agent_messages WHERE content_type LIKE %image% AND agent_data::text ILIKE $1',
      [`%${photoHash}%`]
    );
    return (result.rows[0]?.count || 0) > 1;
  } catch (e) {
    console.error('[ops] check duplicate failed:', e?.message);
    return false;
  }
}

// 强化催办逻辑
async function handleTaskEscalation(taskId, assignee, taskType, overdueMinutes) {
  console.log(`[ops] handling escalation for task ${taskId}, overdue: ${overdueMinutes}min`);
  
  let escalationLevel = 'reminder';
  let message = '';
  
  if (overdueMinutes >= 60) {
    escalationLevel = 'performance_mark';
    message = `⚠️ 任务超时 ${overdueMinutes} 分钟，已标记绩效问题\n任务ID: ${taskId}\n请立即处理！`;
    
    // 标记绩效问题
    try {
      await pool().query(
        `INSERT INTO agent_messages (direction, channel, content_type, content, agent_data)
         VALUES ('system','feishu','performance_issue',$1,$2::jsonb)`,
        [`任务响应迟缓 - ${taskType}`, JSON.stringify({ taskId, assignee, overdueMinutes })]
      );
    } catch (e) {}
    
  } else if (overdueMinutes >= 15) {
    escalationLevel = 'strong_reminder';
    message = `🔔 任务已超时 ${overdueMinutes} 分钟\n任务ID: ${taskId}\n请尽快处理！`;
  } else {
    message = `💡 温馨提醒：任务待处理\n任务ID: ${taskId}`;
  }
  
  // 发送催办消息
  if (assignee?.id) {
    await sendLarkMessage(assignee.id, prefixWithAgentName('ops_supervisor', message));
  }
  
  return { escalationLevel, message };
}

// 逻辑纠偏检查
async function validateSubmissionLogic(submission) {
  console.log('[ops] validating submission logic...');
  
  const issues = [];
  
  // 1. 检查数据逻辑一致性
  if (submission.checkType === '开档检查' && submission.checkStatus === '不合格') {
    if (!submission.checkRemark || submission.checkRemark.length < 10) {
      issues.push('不合格项需要详细说明原因');
    }
  }
  
  // 2. 检查照片与描述的一致性
  if (submission.checkPhotos && submission.checkPhotos.length > 0) {
    if (submission.checkRemark.includes('干净') && submission.checkPhotos.length === 0) {
      issues.push('描述环境干净但未提供照片验证');
    }
  }
  
  // 3. 检查时间逻辑
  const submitHour = new Date(submission.submitTime).getHours();
  if (submission.checkType === '开档检查' && (submitHour < 8 || submitHour > 12)) {
    issues.push('开档检查时间异常，应在上午8-12点进行');
  }
  
  return {
    isValid: issues.length === 0,
    issues,
    suggestion: issues.length > 0 ? `检测到以下问题：${issues.join('；')}。请核实后重新提交。` : ''
  }
}

// ─────────────────────────────────────────────
// Send plain text message to a user by open_id
export async function sendLarkMessage(openId, text, options = {}) {
  // 消息去重检查（BI确定性回复跳过去重，因为用户可能重复查同一指标）
  if (!options.skipDedup && !deduplicateMessage(text, openId)) {
    return { ok: true, deduplicated: true };
  }
  
  const token = await getLarkTenantToken();
  if (!token) { console.error('[feishu] cannot send: no token'); return { ok: false, error: 'no_token' }; }
  try {
    const resp = await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages',
      { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, params: { receive_id_type: 'open_id' }, timeout: 10000 }
    );
    console.log('[feishu] message sent to', openId, '→', resp.data?.code === 0 ? 'ok' : resp.data?.msg);
    if (resp.data?.code === 99992361 || String(resp.data?.msg || '').includes('open_id cross app')) {
      try {
        await pool().query(
          `UPDATE feishu_users
           SET registered = FALSE, updated_at = NOW()
           WHERE open_id = $1`,
          [String(openId || '').trim()]
        );
      } catch (e) {}
    }
    return { ok: resp.data?.code === 0, data: resp.data };
  } catch (e) {
    const code = Number(e?.response?.data?.code || 0);
    const msg = String(e?.response?.data?.msg || '').toLowerCase();
    if (code === 99992361 || msg.includes('open_id cross app')) {
      try {
        await pool().query(
          `UPDATE feishu_users
           SET registered = FALSE, updated_at = NOW()
           WHERE open_id = $1`,
          [String(openId || '').trim()]
        );
      } catch (err) {}
    }
    console.error('[feishu] send message failed:', e?.response?.data || e?.message);
    return { ok: false, error: String(e?.message || e) };
  }
}

// Send interactive card (rich message) to a user
export async function sendLarkCard(openId, card) {
  const token = await getLarkTenantToken();
  if (!token) return { ok: false, error: 'no_token' };
  try {
    const resp = await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages',
      { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card) },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, params: { receive_id_type: 'open_id' }, timeout: 10000 }
    );
    return { ok: resp.data?.code === 0, data: resp.data };
  } catch (e) {
    console.error('[feishu] send card failed:', e?.response?.data || e?.message);
    return { ok: false, error: String(e?.message || e) };
  }
}

// Download image from Feishu message
export async function getLarkImageUrl(messageId, imageKey) {
  const token = await getLarkTenantToken();
  if (!token) return null;
  try {
    const resp = await axios.get(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}`,
      { headers: { 'Authorization': `Bearer ${token}` }, params: { type: 'image' }, responseType: 'arraybuffer', timeout: 30000 }
    );
    const b64 = Buffer.from(resp.data).toString('base64');
    return `data:image/jpeg;base64,${b64}`;
  } catch (e) {
    console.error('[feishu] get image failed:', e?.message);
    return null;
  }
}

// ── 飞书语音识别 (Feishu ASR, 零LLM算力) ──
async function recognizeLarkAudio(messageId, fileKey) {
  const token = await getLarkTenantToken();
  if (!token) return null;

  // 方案1: 通过 IM 消息 API 获取内置语音识别文本 (部分飞书版本自动转写)
  try {
    const msgResp = await axios.get(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`,
      { headers: { 'Authorization': `Bearer ${token}` }, timeout: 10000 }
    );
    const msgBody = msgResp.data?.data?.items?.[0]?.body || msgResp.data?.data?.body || {};
    const recognition = msgBody?.content ? (() => {
      try {
        const parsed = JSON.parse(msgBody.content) || {};
        return parsed?.recognition || parsed?.text || parsed?.transcript || '';
      } catch {
        return '';
      }
    })() : '';
    if (recognition.trim()) {
      console.log(`[feishu-asr] IM API recognition: "${recognition.trim().slice(0, 80)}"`);
      return recognition.trim();
    }
  } catch (e) {
    console.log(`[feishu-asr] IM API fallback skipped: ${e?.response?.status || e?.message}`);
  }

  // 方案2: 下载语音文件 → 调用飞书 Speech API
  try {
    const audioResp = await axios.get(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}`,
      { headers: { 'Authorization': `Bearer ${token}` }, params: { type: 'file' }, responseType: 'arraybuffer', timeout: 30000 }
    );
    const audioBase64 = Buffer.from(audioResp.data).toString('base64');
    console.log(`[feishu-asr] audio downloaded: ${audioResp.data.byteLength} bytes`);

    const asrPayload = {
      speech: { speech: audioBase64 },
      config: { engine_type: '16k_auto', file_id: messageId, format: 'opus' }
    };
    const asrEndpoints = [
      'https://open.feishu.cn/open-apis/speech/v1/speech/file_recognize',
      'https://open.feishu.cn/open-apis/speech_to_text/v1/speech/file_recognize'
    ];
    for (const endpoint of asrEndpoints) {
      try {
        const asrResp = await axios.post(
          endpoint,
          asrPayload,
          { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        const recognized = asrResp.data?.data?.recognition_text || asrResp.data?.data?.text || '';
        if (recognized.trim()) {
          console.log(`[feishu-asr] Speech API recognized via ${endpoint}: "${recognized.slice(0, 80)}"`);
          return recognized.trim();
        }
      } catch (ee) {
        const status = ee?.response?.status;
        if (status !== 404) throw ee;
      }
    }
  } catch (e) {
    const status = e?.response?.status;
    if (status === 404 || status === 403) {
      console.warn(`[feishu-asr] Speech API ${status} — 需在飞书开放平台开通"语音识别"权限 (speech:speech)`);
    } else {
      console.error('[feishu-asr] Speech API error:', e?.response?.data?.msg || e?.message);
    }
  }

  return null;
}

// Reply to a specific message
async function replyLarkMessage(messageId, text) {
  const token = await getLarkTenantToken();
  if (!token) return { ok: false };
  try {
    const resp = await axios.post(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`,
      { msg_type: 'text', content: JSON.stringify({ text }) },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    return { ok: resp.data?.code === 0 };
  } catch (e) {
    console.error('[feishu] reply failed:', e?.message);
    return { ok: false };
  }
}

// ─────────────────────────────────────────────
// 5. Feishu ↔ HRMS User Mapping
// ─────────────────────────────────────────────

async function lookupFeishuUser(openId) {
  try {
    const r = await pool().query('SELECT * FROM feishu_users WHERE open_id = $1 LIMIT 1', [openId]);
    return r.rows?.[0] || null;
  } catch (e) { return null; }
}

export async function lookupFeishuUserByUsername(username) {
  try {
    const r = await pool().query(
      `SELECT *
       FROM feishu_users
       WHERE username = $1 AND registered = TRUE
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [username]
    );
    return r.rows?.[0] || null;
  } catch (e) { return null; }
}

// 推送督办消息给责任人；仅高优先级异常才抄送总部营运和管理员
// H6-FIX: 合并为单次 getSharedState 调用，避免批量场景下的DB过载
async function pushIssueToAssignee(issue, message) {
  const recipients = [];
  
  // 1. 发送给直接责任人（店长/出品经理）
  if (issue.assignee_username) {
    const assignee = await lookupFeishuUserByUsername(issue.assignee_username);
    if (assignee?.open_id) {
      recipients.push({ openId: assignee.open_id, role: 'assignee', username: issue.assignee_username });
    }
  }
  
  // 2+3. 仅高优先级异常才抄送总部营运和管理员（避免通知泛滥）
  const isHighSeverity = String(issue.severity || '').toLowerCase() === 'high';
  if (isHighSeverity) {
    try {
      const state = await getSharedState();
      const allUsers = [
        ...(Array.isArray(state?.employees) ? state.employees : []),
        ...(Array.isArray(state?.users) ? state.users : [])
      ];
      
      // 总部营运（hq_manager）
      const hqManagers = allUsers.filter(u => u.role === 'hq_manager');
      for (const mgr of hqManagers) {
        const fu = await lookupFeishuUserByUsername(mgr.username);
        if (fu?.open_id) {
          recipients.push({ openId: fu.open_id, role: 'hq_manager', username: mgr.username });
        }
      }
      
      // 管理员（admin）
      const admins = allUsers.filter(u => u.role === 'admin');
      for (const adm of admins) {
        const fu = await lookupFeishuUserByUsername(adm.username);
        if (fu?.open_id) {
          recipients.push({ openId: fu.open_id, role: 'admin', username: adm.username });
        }
      }
    } catch (e) {
      console.error('[pushIssue] 查找抄送人失败:', e?.message);
    }
  }
  
  // 发送消息给所有接收人
  const results = [];
  for (const recipient of recipients) {
    try {
      // 根据角色调整消息前缀
      let roleLabel = '';
      if (recipient.role === 'assignee') {
        roleLabel = `【OP督办】`;
      } else if (recipient.role === 'hq_manager') {
        roleLabel = `【OP督办-抄送总部营运】`;
      } else if (recipient.role === 'admin') {
        roleLabel = `【OP督办-抄送管理员】`;
      }
      
      const fullMessage = `${roleLabel}\n${message}`;
      const result = await sendLarkMessage(recipient.openId, fullMessage);
      results.push({ ...recipient, success: result.ok });
    } catch (e) {
      console.error(`[pushIssue] 发送给${recipient.username}失败:`, e?.message);
      results.push({ ...recipient, success: false, error: e?.message });
    }
  }
  
  return { issueId: issue.id, recipients: results.length, results };
}

async function registerFeishuUser(openId, username) {
  const state = await getSharedState();
  const user = findUserInState(state, username);
  if (!user) return { ok: false, error: 'user_not_found' };

  const uname = String(user.username || username).trim();
  const name = String(user.name || '').trim();
  const store = String(user.store || '').trim();
  const brandCtx = resolveBrandContextByStore(state, store);
  const role = String(user.role || '').trim();

  try {
    await pool().query(
      `UPDATE feishu_users
       SET registered = FALSE, updated_at = NOW()
       WHERE username = $1 AND open_id <> $2`,
      [uname, openId]
    );

    await pool().query(
      `INSERT INTO feishu_users (open_id, username, name, store, role, registered)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       ON CONFLICT (open_id) DO UPDATE SET username = $2, name = $3, store = $4, role = $5, registered = TRUE, updated_at = NOW()`,
      [openId, uname, name, store, role]
    );
    return { ok: true, user: { username: uname, name, store, role, brandId: brandCtx.brandId, brandName: brandCtx.brandName } };
  } catch (e) {
    console.error('[feishu] register user failed:', e?.message);
    return { ok: false, error: String(e?.message) };
  }
}

// Build an alert card for Feishu
function buildAlertCard(title, severity, detail, actions) {
  const color = severity === 'high' ? 'red' : 'orange';
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: detail } }
  ];
  if (actions && actions.length) {
    elements.push({
      tag: 'action',
      actions: actions.map(a => ({
        tag: 'button',
        text: { tag: 'plain_text', content: a.text },
        type: a.type || 'default',
        value: a.value || {}
      }))
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: color },
    elements
  };
}

// ─────────────────────────────────────────────
// 6. Agent 1: Data Auditor (数据审计员)
// ─────────────────────────────────────────────

// 注意：扣分规则已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// 注意：图片审核扣分规则已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// 注意：品牌评分模型已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// 注意：扣分计算函数已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// 注意：扣分计算函数已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// 注意：图片审核扣分函数已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// 注意：品牌维度得分计算函数已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// 注意：月度绩效计算函数已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// ─────────────────────────────────────────────
// Data Auditor 核心功能：只负责异常检测，不负责评分
// ─────────────────────────────────────────────

export async function runDataAuditor() {
  await refreshBiAgentRuntimeConfig();
  const state = await getSharedState();
  const reports = Array.isArray(state?.dailyReports) ? state.dailyReports : [];
  const stores = getStoresFromState(state);
  const issues = [];
  const enableDailyReports = isBiSourceEnabled('daily_reports');
  const enableTableVisit = isBiSourceEnabled('table_visit_records') || isBiSourceEnabled('table_visit_bitable');
  const enableBadReviews = isBiSourceEnabled('bad_reviews');
  
  // 重新启用数据源质量检查（带错误处理）
  await checkDataSourceQuality();

  for (const storeInfo of stores) {
    const storeName = storeInfo.name;
    const brandCtx = resolveBrandContextByStore(state, storeName);
    const brand = brandCtx.brandName || storeInfo.brand || inferBrandFromStoreName(storeName) || '洪潮';

    const now = new Date();
    const nowDate = toDateOnly(now.toISOString());
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const weekAgoDate = toDateOnly(weekAgo.toISOString());

    const normalizedStoreName = normalizeStoreKey(storeName);
    const storeReports = enableDailyReports ? reports.filter(r => {
      if (normalizeStoreKey(r?.store) !== normalizedStoreName) return false;
      return inDateRangeInclusive(r?.date, weekAgoDate, nowDate);
    }) : [];
    if (enableDailyReports && !storeReports.length) {
      // 报告数据源不足问题
      await AgentCommunicationHelper.reportDataSourceIssue(
        'daily_reports',
        `门店 ${storeName} 缺少营业数据`,
        '无法进行营收异常检测',
        '建议检查数据同步机制'
      );
    }

    const tableVisitMetrics = enableTableVisit
      ? await loadTableVisitMetricsByStore(storeName, weekAgoDate, nowDate)
      : { countByDate: new Map(), dissatisfiedProducts: new Map(), dissatisfiedByDate: new Map(), productLabelByKey: new Map() };
    const reportsSorted = storeReports
      .slice()
      .sort((a, b) => String(a?.date || '').localeCompare(String(b?.date || '')));

    // 1) 实收营收异常 - 阈值从配置中心读取，支持门店级别覆盖
    const revenueGapMedium = getStoreThreshold(storeName, 'revenueGapMedium', 0.10);
    const revenueGapHigh = getStoreThreshold(storeName, 'revenueGapHigh', 0.20);
    if (enableDailyReports) {
      const ym = nowDate.slice(0, 7);
      const target = getMonthlyTarget(state, ym, storeName);
      const targetActual = toNum(target?.targets?.actual, 0);
      if (targetActual > 0) {
      // 获取当月1号到当前日期（上周日）的所有数据
      const monthStart = `${ym}-01`;
      const monthReports = storeReports.filter(r => {
        const d = toDateOnly(r?.date);
        return d && d >= monthStart && d <= nowDate;
      });
      
      // 累计实收营业额
      const cumulativeActual = monthReports.reduce((s, r) => s + toNum(r?.data?.actual, 0), 0);
      // 已过天数（从上个月1号到上周日）
      const daysPassed = monthReports.length;
      const monthDays = Math.max(1, daysInMonth(nowDate));
      
      // 实际达成率 vs 理论达成率
      const actualAchieveRate = cumulativeActual / targetActual;
      const theoryAchieveRate = daysPassed / monthDays;
      const gap = theoryAchieveRate - actualAchieveRate;
      
      if (gap > revenueGapMedium) {
        const severity = gap > revenueGapHigh ? 'high' : 'medium';
        issues.push({
          agent: 'data_auditor', brand, store: storeName, category: '实收营收异常',
          severity,
          title: `${storeName} 累计实收营收达成偏低（${daysPassed}天较理论差 ${(gap * 100).toFixed(1)}%）`,
          detail: `${ym}月1日至${nowDate}累计：实收达成率 ${(actualAchieveRate * 100).toFixed(1)}%，理论达成率 ${(theoryAchieveRate * 100).toFixed(1)}%（${daysPassed}/${monthDays}天），差值 ${(gap * 100).toFixed(1)}%。`,
          data: {
            date: nowDate,
            periodStart: monthStart,
            periodEnd: nowDate,
            daysPassed,
            monthDays,
            cumulativeActual: Number(cumulativeActual.toFixed(2)),
            targetActual: Number(targetActual.toFixed(2)),
            actualAchieveRate: Number((actualAchieveRate * 100).toFixed(2)),
            theoryAchieveRate: Number((theoryAchieveRate * 100).toFixed(2)),
            achieveGap: Number((gap * 100).toFixed(2))
          }
        });
      }
    }
    }

    // 2) 人效值异常 - 阈值从配置中心读取，支持门店级别覆盖
    const efficiencyThresholds = {
      medium: getStoreThreshold(storeName, 'efficiencyMedium', 1100),
      high: getStoreThreshold(storeName, 'efficiencyHigh', 1000)
    };

    if (enableDailyReports) for (const report of reportsSorted) {
      const data = report?.data || {};
      const reportDate = toDateOnly(report?.date);
      if (!reportDate) continue;
      const gross = toNum(data?.gross, 0);
      const laborTotal = toNum(data?.laborTotal, 0);
      const efficiency = toNum(data?.efficiency, laborTotal > 0 ? (gross / laborTotal) : 0);
      if (!(efficiency > 0)) continue;

      let severity = '';
      if (efficiency < efficiencyThresholds.high) severity = 'high';
      else if (efficiency < efficiencyThresholds.medium) severity = 'medium';
      if (!severity) continue;

      issues.push({
        agent: 'data_auditor', brand, store: storeName, category: '人效值异常',
        severity,
        title: `${storeName} ${reportDate} 人效偏低（${efficiency.toFixed(0)}）`,
        detail: `品牌阈值：medium < ${efficiencyThresholds.medium}，high < ${efficiencyThresholds.high}。当前人效 ${efficiency.toFixed(0)}。`,
        data: { date: reportDate, efficiency: Number(efficiency.toFixed(2)) }
      });
    }

    // 3) 充值异常 - 阈值从配置中心读取
    const rechargeHighDays = Math.max(2, getStoreThreshold(storeName, 'rechargeStreakHighDays', 2));
    let rechargeStreak = 0;
    let prevDate = '';
    for (const report of reportsSorted) {
      const reportDate = toDateOnly(report?.date);
      if (!reportDate) continue;
      const rechargeAmount = toNum(report?.data?.recharge?.amount, 0);
      const noRecharge = rechargeAmount <= 0;

      if (noRecharge) {
        issues.push({
          agent: 'data_auditor', brand, store: storeName, category: '充值异常',
          severity: 'medium',
          title: `${storeName} ${reportDate} 当日无充值`,
          detail: `当日充值金额为 0。`,
          data: { date: reportDate, rechargeAmount: 0 }
        });
      }

      if (noRecharge && isConsecutiveDate(prevDate, reportDate)) rechargeStreak += 1;
      else rechargeStreak = noRecharge ? 1 : 0;

      if (rechargeStreak >= rechargeHighDays) {
        issues.push({
          agent: 'data_auditor', brand, store: storeName, category: '充值异常',
          severity: 'high',
          title: `${storeName} 连续${rechargeHighDays}天无充值`,
          detail: `截至 ${reportDate} 已连续 ${rechargeStreak} 天无充值。`,
          data: { date: reportDate, noRechargeDays: rechargeStreak }
        });
      }
      prevDate = reportDate;
    }

    // 4) 桌访产品异常 - 阈值从配置中心读取
    const productMedium = Math.max(1, getStoreThreshold(storeName, 'tableVisitProductMedium', 2));
    const productHigh = Math.max(productMedium, getStoreThreshold(storeName, 'tableVisitProductHigh', 4));
    const productComplaints = tableVisitMetrics.dissatisfiedProducts;
    if (enableTableVisit) for (const [key, count] of productComplaints) {
      if (count >= productMedium) {
        const [, productKey] = key.split('||');
        const product = tableVisitMetrics.productLabelByKey.get(productKey) || productKey || '未知产品';
        issues.push({
          agent: 'data_auditor', brand, store: storeName, category: '桌访产品异常',
          severity: count >= productHigh ? 'high' : 'medium',
          title: `${storeName} 近7天「${product}」不满意 ${count} 次`,
          detail: `同一产品7天内不满意次数 ${count} 次（medium:≥${productMedium}次, high:≥${productHigh}次）。`,
          data: { date: nowDate, dissatisfiedProducts: product, dissatisfiedCount: count }
        });
      }
    }

    // 5) 桌访占比异常 - 阈值从配置中心读取
    const ratioMedium = getStoreThreshold(storeName, 'tableVisitRatioMedium', 0.5);
    const ratioHigh = getStoreThreshold(storeName, 'tableVisitRatioHigh', 0.4);
    const weekVisits = Array.from(tableVisitMetrics.countByDate.values()).reduce((s, n) => s + toNum(n, 0), 0);
    // 从营业日报获取堂食订单数作为总桌数
    const weekDineOrders = storeReports.reduce((s, r) => s + toNum(r?.data?.dine?.orders, 0), 0);
    const tableVisitRatio = weekDineOrders > 0 ? (weekVisits / weekDineOrders) : 0;
    if (enableTableVisit && enableDailyReports && weekDineOrders > 0 && tableVisitRatio < ratioMedium) {
      issues.push({
        agent: 'data_auditor', brand, store: storeName, category: '桌访占比异常',
        severity: tableVisitRatio < ratioHigh ? 'high' : 'medium',
        title: `${storeName} 近7天桌访占比偏低（${(tableVisitRatio * 100).toFixed(1)}%）`,
        detail: `桌访数量 ${weekVisits}，堂食订单数量 ${weekDineOrders}，桌访占比 ${(tableVisitRatio * 100).toFixed(1)}%（medium:<${(ratioMedium*100).toFixed(0)}%, high:<${(ratioHigh*100).toFixed(0)}%）。`,
        data: {
          date: nowDate,
          tableVisitCount: weekVisits,
          dineOrders: weekDineOrders,
          tableVisitOrderRatio: Number((tableVisitRatio * 100).toFixed(2))
        }
      });
    }

    // 6) 总实收毛利率异常 - 阈值从配置中心读取，支持门店级别覆盖
    const marginMedium = getStoreThreshold(storeName, 'marginMedium', 0.69);
    const marginHigh = getStoreThreshold(storeName, 'marginHigh', 0.68);
    const marginMetrics = await estimateMarginMetricsForRange({
      state,
      store: storeName,
      startDate: weekAgoDate,
      endDate: nowDate
    });
    const totalMarginRate = toNum(marginMetrics?.total?.marginRate, 0);
    const marginThresholds = { medium: marginMedium, high: marginHigh };
    if (marginMetrics.total.actualRevenue > 0 && totalMarginRate < marginThresholds.medium) {
      issues.push({
        agent: 'data_auditor', brand, store: storeName, category: '总实收毛利率异常',
        severity: totalMarginRate < marginThresholds.high ? 'high' : 'medium',
        title: `${storeName} 近7天总实收毛利率偏低（${(totalMarginRate * 100).toFixed(1)}%）`,
        detail: `品牌阈值：medium < ${(marginThresholds.medium * 100).toFixed(0)}%，high < ${(marginThresholds.high * 100).toFixed(0)}%。当前 ${(totalMarginRate * 100).toFixed(1)}%。`,
        data: {
          date: nowDate,
          totalActualRevenue: Number(toNum(marginMetrics?.total?.actualRevenue, 0).toFixed(2)),
          totalEstimatedCost: Number(toNum(marginMetrics?.total?.estimatedCost, 0).toFixed(2)),
          totalMarginRate: Number((totalMarginRate * 100).toFixed(2))
        }
      });
    }

    // 7) 产品差评异常 / 服务差评异常 - 阈值从配置中心读取
    const badReviewMedium = Math.max(1, getStoreThreshold(storeName, 'badReviewMedium', 1));
    const badReviewHigh = Math.max(badReviewMedium, getStoreThreshold(storeName, 'badReviewHigh', 2));
    try {
      const day7Ago = new Date(now.getTime() - 7 * 86400000);
      const day7AgoDate = toDateOnly(day7Ago.toISOString());

      // 产品差评统计（1周内）
      const productReviews = await pool().query(
        `SELECT product_name, COUNT(*) as cnt
         FROM bad_reviews
         WHERE lower(regexp_replace(store, '\\s+', '', 'g')) = $1 AND review_type = 'product'
           AND date >= $2::date AND date <= $3::date
           AND product_name IS NOT NULL AND product_name != ''
         GROUP BY product_name`,
        [normalizeStoreKey(storeName), day7AgoDate, nowDate]
      );

      for (const row of (productReviews.rows || [])) {
        const product = String(row.product_name || '').trim();
        const count7d = Number(row.cnt || 0);
        if (count7d >= badReviewMedium) {
          issues.push({
            agent: 'data_auditor', brand, store: storeName, category: '产品差评异常',
            severity: count7d >= badReviewHigh ? 'high' : 'medium',
            title: `${storeName} 「${product}」近7天收到 ${count7d} 次产品差评`,
            detail: `产品「${product}」在7天内收到 ${count7d} 次差评（medium:≥${badReviewMedium}条, high:≥${badReviewHigh}条）。`,
            data: {
              date: nowDate,
              productName: product,
              reviewCount: count7d,
              periodDays: 7,
              reviewType: 'product'
            }
          });
        }
      }

      // 服务差评统计（1周内）
      const serviceReviews = await pool().query(
        `SELECT service_item, COUNT(*) as cnt
         FROM bad_reviews
         WHERE lower(regexp_replace(store, '\\s+', '', 'g')) = $1 AND review_type = 'service'
           AND date >= $2::date AND date <= $3::date
           AND service_item IS NOT NULL AND service_item != ''
         GROUP BY service_item`,
        [normalizeStoreKey(storeName), day7AgoDate, nowDate]
      );

      for (const row of (serviceReviews.rows || [])) {
        const service = String(row.service_item || '').trim();
        const count7d = Number(row.cnt || 0);
        if (count7d >= badReviewMedium) {
          issues.push({
            agent: 'data_auditor', brand, store: storeName, category: '服务差评异常',
            severity: count7d >= badReviewHigh ? 'high' : 'medium',
            title: `${storeName} 「${service}」服务近7天收到 ${count7d} 次差评`,
            detail: `服务项「${service}」在7天内收到 ${count7d} 次差评（medium:≥${badReviewMedium}条, high:≥${badReviewHigh}条）。`,
            data: {
              date: nowDate,
              serviceItem: service,
              reviewCount: count7d,
              periodDays: 7,
              reviewType: 'service'
            }
          });
        }
      }
    } catch (e) {
      // bad_reviews表可能不存在，忽略
    }

    // 8) 收档得分异常 - 已按用户要求取消
    // 9) 原料收货异常 - 已按用户要求取消
  }

  // Persist and return
  let created = 0;
  const newIssueIds = [];
  for (const issue of issues) {
    try {
      // Dedup by store + category + report date (not title, which can vary between runs)
      const issueDate = String(issue.data?.date || '').trim();
      const existing = await pool().query(
        `SELECT id FROM agent_issues
         WHERE store = $1 AND category = $2
           AND (data->>'date' = $3 OR ($3 = '' AND created_at > NOW() - INTERVAL '24 hours'))
           AND created_at > NOW() - INTERVAL '7 days'
         LIMIT 1`,
        [issue.store, issue.category, issueDate]
      );
      if (existing.rows?.length) continue;

      // 按异常类型查找责任人角色（原料异常→出品经理，服务异常→店长等）
      let assignee = null;
      try {
        const roleMap = await getCategoryAssigneeRoleMap();
        const targetRole = roleMap[issue.category] || 'store_manager';
        const normalizedStore = normalizeStoreKey(issue.store);
        const allUsers = [
          ...(Array.isArray(state?.employees) ? state.employees : []),
          ...(Array.isArray(state?.users) ? state.users : [])
        ];
        let assigneeUser = allUsers.find(u =>
          normalizeStoreKey(u?.store) === normalizedStore &&
          String(u?.role || '').trim() === targetRole
        );
        // 出品经理找不到则降级到店长
        if (!assigneeUser && targetRole === 'store_production_manager') {
          assigneeUser = allUsers.find(u =>
            normalizeStoreKey(u?.store) === normalizedStore &&
            String(u?.role || '').trim() === 'store_manager'
          );
        }
        assignee = assigneeUser ? String(assigneeUser.username || '').trim() : null;
      } catch (e) {
        assignee = await findStoreManager(state, issue.store);
      }
      const r = await pool().query(
        `INSERT INTO agent_issues (agent, brand, store, category, severity, title, detail, data, assignee_username)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) RETURNING id`,
        [issue.agent, issue.brand, issue.store, issue.category, issue.severity,
         issue.title, issue.detail, JSON.stringify(issue.data), assignee]
      );

      // 同步输出标准化 KPI 雷达报警 JSON 给 Master Agent（用于编排调度）
      const radarPayload = buildKpiRadarAlertJson(issue);
      await pool().query(
        `INSERT INTO agent_messages (direction, channel, sender_name, routed_to, content_type, content, agent_data)
         VALUES ('out', 'system', 'BI Radar', 'master', 'kpi_radar_alert', $1, $2::jsonb)`,
        [JSON.stringify(radarPayload), JSON.stringify({ route: 'master', kpiRadar: true, payload: radarPayload })]
      );

      created++;
      if (r.rows?.[0]?.id) newIssueIds.push(r.rows[0].id);
    } catch (e) {
      console.error('[data_auditor] insert issue failed:', e?.message);
    }
  }

  return { scanned: reports.length, issuesFound: issues.length, issuesCreated: created, newIssueIds };
}

// ─────────────────────────────────────────────
// 7. Agent 2: Operational Supervisor (营运督导员)
// ─────────────────────────────────────────────

// 营运督导员工作职责配置
let OPS_AGENT_CONFIG = {
  llmModels: {
    reasoningModel: 'deepseek-chat',
    visionModel: 'doubao-seed-2-0-pro-260215'
  },
  // 任务调度与主动触发
  scheduledTasks: {
    // 开/收市巡检
    dailyInspections: [
      
    ],
    // 食安抽检
    randomInspections: [
      
    ],
    // 数据联动触发阈值（配合BI异常检测规则）
    dataTriggers: {
      // 产品投诉阈值：1周内同一产品投诉>2次触发medium，>4次触发high
      productComplaintThreshold: 2, 
      // 毛利偏差阈值：马己仙<64%/洪潮<69%为medium
      marginDeviationThreshold: 0.01, // 使用较小的容差确保能触发
      // 桌访率阈值：桌访率<50%触发medium，<40%触发high
      tableVisitRatioThreshold: 0.50  
    }
  },

  // 多模态视觉审核标准
  visualInspection: {
    // 环境检查标准
    environment: {
      floorWater: 'detect_water_or_oil_on_floor',
      trashCovered: 'trash_bin_lid_closed',
      lightingAdequate: 'lighting_sufficient_for_clear_photos'
    },
    // 产品检查标准  
    product: {
      platingAesthetics: '洪潮切配摆盘美学标准',
      portionSize: '分量是否达标',
      garnishPlacement: '装饰配菜摆放规范'
    },
    // 物料检查标准
    materials: {
      fridgeLabelExpiry: '冰箱标签是否过期',
      rawCookedSeparation: '生熟分装检查',
      storageTemperature: '储存温度合规'
    },
    // 视觉准确度要求
    accuracyThresholds: {
      labelClarity: 0.8,      // 标识清晰度 > 80%
      foodCoverage: 0.9,     // 食材遮盖率达标
      photoQuality: 0.85     // 照片质量要求
    }
  },

  // 执行闭环追踪
  loopManagement: {
    // 催办逻辑
    followUpRules: {
      firstReminder: 60,  // 60分钟内未读信
      secondReminder: 90, // 90分钟内未首次反馈
      escalationDelay: 120, // 2小时后升级
      maxReminders: 3      // 最多提醒3次
    },
    // 逻辑纠偏检查
    logicValidation: {
      photoLocationRadius: 500, // 门店500米内
      exifTimeTolerance: 5,     // Exif时间误差<5分钟
      hashDuplicateCheck: true, // Hash重复检查
      dataConsistency: true     // 数据一致性检查
    }
  },

  // 判定逻辑标准
  judgmentStandards: {
    timeliness: {
      readDeadline: 15,    // 15分钟内读信
      responseDeadline: 60, // 60分钟内首次反馈
      latePenalty: 'mark_slow_response' // 超时标记响应迟缓
    },
    authenticity: {
      locationRadius: 500,
      exifTolerance: 300,  // 5分钟=300秒
      hashCheck: true,
      fraudAction: 'block_and_report' // 作假直接封禁并上报
    },
    visualAccuracy: {
      minClarity: 0.8,
      minCoverage: 0.9,
      poorQualityResponse: '环境光线不足，请打开补光灯重拍'
    },
    logicConsistency: {
      dataTolerance: 0.1,   // 10%数据偏差容忍度
      inconsistencyResponse: '检测到数据偏差较大，请核实后再提交'
    }
  },

  // 现场知识支援
  knowledgeSupport: {
    // SOP知识库调用规则
    sopQueryRules: {
      productQuality: '产品质量问题处理流程',
      ingredientHandling: '食材处理标准',
      equipmentOperation: '设备操作规范',
      emergencyProcedures: '紧急情况处理'
    },
    // 常见问题标准回复
    standardResponses: {
      smallOysters: '根据洪潮验收SOP第3条，超过20%不达标需拍图留存并做退货登记。请拍摄对比照片。',
      fridgeTemperature: '冰箱温度应保持在4°C以下，请检查温控设置并记录当前温度。',
      handWashing: '洗手必须满20秒，请使用洗手液并冲洗至手腕部位。'
    }
  }
};

export async function auditImage(imageUrl, auditType, context = {}) {
  const store = context.store || '';
  const brand = context.brand || '';
  const username = context.username || '';
  const config = OPS_AGENT_CONFIG;

  // Anti-cheat: image hash
  let imageHash = '';
  let exifData = {};
  try {
    let buf;
    if (imageUrl.startsWith('/') || imageUrl.startsWith('.')) {
      buf = fs.readFileSync(imageUrl);
    } else if (imageUrl.startsWith('data:')) {
      const b64 = imageUrl.split(',')[1] || '';
      buf = Buffer.from(b64, 'base64');
    }
    if (buf) {
      imageHash = crypto.createHash('sha256').update(buf).digest('hex');
      // TODO: 提取Exif数据用于时间验证
      exifData = { timestamp: new Date().toISOString() }; // 临时使用当前时间
    }
  } catch (e) {}

  let duplicateOf = null;
  if (imageHash) {
    try {
      const dup = await pool().query(
        `SELECT id FROM agent_visual_audits WHERE image_hash = $1 LIMIT 1`, [imageHash]
      );
      if (dup.rows?.length) duplicateOf = dup.rows[0].id;
    } catch (e) {}
  }

  // 根据审核类型选择Prompt
  const typePrompts = {
    hygiene: `你是餐饮卫生检查专家。严格审核这张图片。如果是手机截图/屏幕录制/非实拍照片/与卫生无关的图片，必须判定fail。只有清晰的餐厅现场卫生实拍照片才可能pass。1.是否为真实卫生相关实拍 2.卫生状况如何 3.给出pass/fail/unclear。JSON回复：{"result":"pass/fail/unclear","confidence":0.0-1.0,"findings":"具体发现","clarity":0.0-1.0}`,
    plating: `你是餐饮出品专家。严格审核这张图片。如果是手机截图/屏幕录制/非实拍照片/与菜品出品无关的图片，必须判定fail。只有清晰的菜品实拍照片才可能pass。1.摆盘是否规范 2.分量是否达标 3.美学标准。JSON回复：{"result":"pass/fail/unclear","confidence":0.0-1.0,"findings":"具体发现","clarity":0.0-1.0}`,
    general: `你是餐饮门店食品安全与卫生审核专家。你的任务是严格审核食安巡检照片。

【必须判定为fail的情况】：
- 手机截图、屏幕录制、非实拍照片
- 与食品安全/卫生/餐饮现场完全无关的照片（如系统界面、聊天记录、风景照等）
- 照片模糊无法辨认内容
- 明显不是在门店现场拍摄的照片

【可以判定为pass的情况】：
- 清晰的餐厅现场实拍照片（厨房、前厅、仓库、冷柜、操作台等）
- 照片中可见真实的食品、餐具、设备等实物

请严格审核，宁可误判为unclear也不要轻易pass。
JSON回复：{"result":"pass/fail/unclear","confidence":0.0-1.0,"findings":"具体发现","type":"照片类型","clarity":0.0-1.0}`,
    seafood_pool_temperature: `你是海鲜池管理专家。审核这张水温计照片：1.温度是否清晰可见 2.温度是否在标准范围内(18-22°C) 3.水温计是否正常工作。JSON回复：{"result":"pass/fail/unclear","confidence":0.0-1.0,"findings":"具体发现","temperature":"数值"}`
  };

  const prompt = typePrompts[auditType] || typePrompts.general;
  const llmResult = await callVisionLLM(imageUrl, prompt);

  let result = 'unclear', confidence = 0, findings = '', agentRaw = {}, clarity = 0;
  if (llmResult.ok && llmResult.content) {
    try {
      const jsonMatch = llmResult.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        result = String(parsed.result || 'unclear').trim().toLowerCase();
        confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0)));
        findings = String(parsed.findings || '').trim();
        clarity = Math.max(0, Math.min(1, Number(parsed.clarity || 0)));
        agentRaw = parsed;
      }
    } catch (e) { findings = llmResult.content; }
  } else {
    findings = `视觉审核API调用失败: ${llmResult.error || '未知错误'}`;
  }

  // 安全兜底：pass但低置信度 → 降级为unclear
  if (result === 'pass' && confidence < 0.7) {
    result = 'unclear';
    findings = `照片内容不够明确，无法自动判定合格（置信度${(confidence*100).toFixed(0)}%）。请重新拍摄清晰的现场照片。` + (findings ? ' 原始分析: ' + findings : '');
  }

  // 应用判定逻辑标准
  if (duplicateOf) {
    result = 'fail';
    findings = `⚠️ 重复图片（与历史记录重复），疑似作弊。${findings ? ' 原始审核: ' + findings : ''}`;
    confidence = 0.95;
  } else if (clarity < config.visualInspection.accuracyThresholds.labelClarity) {
    result = 'fail';
    findings = config.judgmentStandards.visualAccuracy.poorQualityResponse;
    confidence = 0.9;
  }

  // 时间验证（基于Exif数据）
  const now = new Date();
  const exifTime = new Date(exifData.timestamp || now);
  const timeDiff = Math.abs(now - exifTime) / 1000; // 秒
  if (timeDiff > config.judgmentStandards.authenticity.exifTolerance) {
    result = 'fail';
    findings = `照片拍摄时间异常（误差${Math.round(timeDiff/60)}分钟），请重新拍摄。`;
    confidence = 0.95;
  }

  let auditId = null;
  try {
    const r = await pool().query(
      `INSERT INTO agent_visual_audits (store, brand, username, image_url, audit_type, result, confidence, findings, image_hash, duplicate_of, agent_raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING id`,
      [store, brand, username, imageUrl, auditType || 'general', result, confidence,
       findings, imageHash || null, duplicateOf || null, JSON.stringify(agentRaw)]
    );
    auditId = r.rows?.[0]?.id || null;
  } catch (e) { console.error('[ops_supervisor] insert audit failed:', e?.message); }

  // 图片审核不合格异常记录 - 已按用户要求取消自动创建

  return { auditId, result, confidence, findings, duplicate: !!duplicateOf, imageHash, clarity };
}

// ─────────────────────────────────────────────
// 营运督导员知识支援功能
// ─────────────────────────────────────────────

// 现场知识支援 - 根据问题类型调用SOP知识库
export async function getOpsKnowledgeSupport(query, context = {}) {
  const store = context.store || '';
  const brand = context.brand || '';
  const config = OPS_AGENT_CONFIG.knowledgeSupport;
  
  // 检查是否为常见问题，返回标准回复
  const standardAnswers = {
    '生蚝个头偏小': config.standardResponses.smallOysters,
    '冰箱温度': config.standardResponses.fridgeTemperature,
    '洗手': config.standardResponses.handWashing
  };
  
  for (const [key, answer] of Object.entries(standardAnswers)) {
    if (query.includes(key)) {
      return { type: 'standard', response: answer, source: 'standard_responses' };
    }
  }
  
  // 查询SOP知识库
  let kbResults = [];
  try {
    // 查询知识库和 Bitable 数据
    const brandTag = brand ? `brand:${brand}` : '';
    const agentData = await queryAgentData(['sop', '流程', '标准', '规范'], query, 5, { brandTag });
    
    kbResults = agentData.knowledge || [];
    const bitableResults = agentData.bitable || [];
    
    // 合并结果
    if (bitableResults.length > 0) {
      kbResults = kbResults.concat(
        bitableResults.map(r => ({
          title: `Bitable数据 - ${r.content_type}`,
          content: `${r.content}\n数据时间: ${new Date(r.created_at).toLocaleString()}`,
          source: 'bitable'
        }))
      );
    }
  } catch (e) {
    console.error('[ops_supervisor] data query failed:', e?.message);
  }
  
  if (kbResults.length > 0) {
    const kbContent = kbResults.map(r => `【${r.title}】${r.content}`).join('\n\n');
    return { 
      type: 'knowledge_base', 
      response: `根据相关SOP标准：\n\n${kbContent}`,
      source: 'knowledge_base',
      results: kbResults 
    };
  }
  
  // 使用LLM生成专业建议
  try {
    const llmResult = await callLLM([
      { 
        role: 'system', 
        content: `你是小年，年年有喜餐饮集团AI助理，精通洪潮和马己仙品牌标准。当前门店：${store}（${brand}）。请提供专业、可操作的建议。` 
      },
      { role: 'user', content: query }
    ], { model: getOpsReasoningModel() });
    
    if (llmResult.ok && llmResult.content) {
      return { 
        type: 'llm_generated', 
        response: llmResult.content,
        source: 'ai_advisor'
      };
    }
  } catch (e) {
    console.error('[ops_supervisor] llm advice failed:', e?.message);
  }
  
  return { 
    type: 'fallback', 
    response: '这个问题需要进一步核实，请联系值班经理处理。',
    source: 'fallback'
  };
}

// 任务调度与主动触发
export async function scheduleOpsTasks() {
  const config = OPS_AGENT_CONFIG.scheduledTasks;
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  
  const scheduledTasks = [];
  
  // 检查日常巡检任务
  for (const inspection of config.dailyInspections) {
    if (inspection.time === currentTime) {
      const storeName = String(inspection?.store || '').trim();
      if (!storeName) continue;
      const task = {
        type: 'daily_inspection',
        brand: String(inspection?.brand || '').trim(),
        store: storeName,
        inspectionType: inspection.type,
        checklist: inspection.checklist,
        scheduledTime: now.toISOString()
      };
      scheduledTasks.push(task);
    }
  }
  
  return scheduledTasks;
}

// 数据联动触发检查
export async function checkDataTriggers() {
  const config = OPS_AGENT_CONFIG.scheduledTasks.dataTriggers;
  const triggers = [];
  
  // 检查产品投诉阈值
  try {
    const recentComplaints = await pool().query(`
      SELECT store, product_name, COUNT(*) as complaint_count
      FROM bad_reviews 
      WHERE review_type = 'product' 
        AND created_at > NOW() - INTERVAL '24 hours'
      GROUP BY store, product_name
      HAVING COUNT(*) >= $1
    `, [config.productComplaintThreshold]);
    
    for (const complaint of recentComplaints.rows) {
      triggers.push({
        type: 'product_complaints',
        store: complaint.store,
        product: complaint.product_name,
        count: complaint.complaint_count,
        action: 'check_production_process'
      });
    }
  } catch (e) {
    console.error('[ops_supervisor] data trigger check failed:', e?.message);
  }
  
  return triggers;
}

// 执行闭环追踪 - 催办逻辑
export async function followUpOverdueTasks() {
  const config = OPS_AGENT_CONFIG.loopManagement.followUpRules;
  const now = new Date();
  const followUps = [];
  
  // 检查超时未读的任务
  try {
    const unreadTasks = await pool().query(`
      SELECT t.*, u.open_id, u.name
      FROM master_tasks t
      JOIN users u ON t.assignee_username = u.username
      WHERE t.status = 'dispatched' 
        AND t.created_at < NOW() - make_interval(mins => $2)
        AND t.reminder_count < $1
    `, [config.maxReminders, Math.max(1, Math.floor(Number(config.firstReminder) || 60))]);
    
    for (const task of unreadTasks.rows) {
      // 发送飞书提醒
      const reminderMsg = prefixWithAgentName('ops_supervisor', 
        `【任务提醒】${task.assignee_username}，你有任务已超时${Math.round((now - new Date(task.created_at)) / 60000)}分钟未查看，请及时处理：${task.title}`);
      
      try {
        await sendLarkMessage(task.open_id, reminderMsg);
        
        // 更新提醒次数
        await pool().query(`
          UPDATE master_tasks 
          SET reminder_count = reminder_count + 1, 
              last_reminded_at = NOW()
          WHERE id = $1
        `, [task.id]);
        
        followUps.push({
          taskId: task.id,
          type: 'unread_reminder',
          assignee: task.assignee_username,
          reminderCount: task.reminder_count + 1
        });
      } catch (e) {
        console.error('[ops_supervisor] follow-up failed:', e?.message);
      }
    }
  } catch (e) {
    console.error('[ops_supervisor] overdue tasks check failed:', e?.message);
  }
  
  return followUps;
}

// 辅助函数：根据品牌获取门店列表
async function getStoresForBrand(brandName) {
  const state = await getSharedState();
  const stores = getStoresFromState(state);
  return stores.filter(s => s.brand === brandName);
}

export async function runChiefEvaluator(period) {
  const p = String(period || '').trim();
  if (!p) return { error: 'missing_period' };

  const state = await getSharedState();
  const stores = getStoresFromState(state);
  const results = [];

  for (const storeInfo of stores) {
    const storeName = storeInfo.name;
    const brandCtx = resolveBrandContextByStore(state, storeName);
    const brand = brandCtx.brandName || storeInfo.brand || inferBrandFromStoreName(storeName) || '洪潮';
    const config = getBrandRuntimeConfig(state, brandCtx);

    const all = [
      ...(Array.isArray(state?.employees) ? state.employees : []),
      ...(Array.isArray(state?.users) ? state.users : [])
    ];
    const managers = all.filter(u =>
      String(u?.store || '').trim() === storeName &&
      ['store_manager', 'store_production_manager'].includes(String(u?.role || '').trim())
    );

    // 使用新评分模型计算门店评级
    const storeRating = await calculateStoreRating(storeName, brand, p);

    for (const mgr of managers) {
      const username = String(mgr.username || '').trim();
      const mgrName = String(mgr.name || '').trim();
      const role = String(mgr.role || '').trim();
      if (!username) continue;

      // 使用新评分模型计算员工评分
      const employeeScore = await calculateEmployeeScore(storeName, username, role, p);
      
      if (!employeeScore) {
        console.log(`[HR] 员工评分计算失败: ${username}`);
        continue;
      }

      const totalScore = employeeScore.total_score;
      const breakdown = {
        execution_rating: employeeScore.execution_rating,
        attitude_rating: employeeScore.attitude_rating,
        ability_rating: employeeScore.ability_rating,
        store_rating: storeRating.rating || null
      };
      const deductions = []; // 新模型不使用扣分列表

      let summary = '';
      try {
        const llm = await callLLM([
          { role: 'system', content: '你是专业的餐饮绩效考核官，语言简洁务实。' },
          { role: 'user', content: `品牌${brand}（${config.label}），门店${storeName}，${mgr.name || username}（${role === 'store_manager' ? '店长' : '出品经理'}）。总分${totalScore}，门店评级${storeRating.rating || 'N/A'}，执行力${employeeScore.execution_rating}，态度${employeeScore.attitude_rating}，能力${employeeScore.ability_rating}。请给出2-3句评语。` }
        ]);
        summary = llm.content || '';
      } catch (e) {}

      try {
        await pool().query(
          `INSERT INTO agent_scores (brand, store, username, name, role, period, score_model, total_score, breakdown, deductions, summary)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
           ON CONFLICT (brand, store, username, period)
           DO UPDATE SET name=EXCLUDED.name, total_score=EXCLUDED.total_score, breakdown=EXCLUDED.breakdown, deductions=EXCLUDED.deductions, summary=EXCLUDED.summary, feishu_notified=FALSE, updated_at=NOW()`,
          [brand, storeName, username, mgrName, role, p, 'new_model', totalScore,
           JSON.stringify(breakdown), JSON.stringify(deductions), summary]
        );
      } catch (e) { console.error('[HR] upsert score failed:', e?.message); }

      results.push({ brand, store: storeName, username, name: mgrName, role, totalScore, breakdown, deductions: deductions.length, summary, store_rating: storeRating });
    }
  }

  return { period: p, evaluated: results.length, results, model: 'new_scoring_model' };
}

// ─────────────────────────────────────────────
// 9. Message Router
// ─────────────────────────────────────────────

const AUDIT_KEYWORDS = ['损耗', '盘点', '毛利', '牛肉', '成本', '差评', '折扣', '营收', '对账', '异常'];
const OPS_KEYWORDS = ['图片', '卫生', '检查', '拍照', '摆盘', '收货', '消毒', '开市', '闭市', '巡检'];
const EVAL_KEYWORDS = ['分数', '绩效', '考核', '奖金', '得分', '扣分', '排名', '评价', '这周'];
const HR_KEYWORDS = ['离职', '辞职', '入职', '转正', '晋升', '调岗', '加薪', '薪资', '工资', '请假', '休假', '社保', '人事', '档案', '考勤'];
const APPEAL_KEYWORDS = ['申诉', '取消扣分', '不公平', '误判', '恢复', '投诉', '举报'];
const SOP_KEYWORDS = ['SOP', '赔付', '退款', '培训', '入职培训', '课件', '带教', '讲师', '考核培训', '技能培训', '标准作业'];

// Agent name prefix mapping
const AGENT_PREFIX = {
  data_auditor: '小年',
  ops_supervisor: '小年',
  chief_evaluator: '小年',
  train_advisor: '小年',
  sop_advisor: '小年',
  appeal: '小年',
  master: '小年',
  general: '小年'
};

export function prefixWithAgentName(route, text) {
  const prefix = AGENT_PREFIX[route] || 'HRMS';
  return `${prefix}：${text}`;
}

async function buildBiGroundingFacts(store, text) {
  const q = String(text || '').trim();
  const targetStore = String(store || '').trim();
  if (!targetStore) return '';
  const askReviewLike = /(差评|点评|评论|桌访|产品问题|反馈|口味|出品|上菜|服务)/.test(q);
  if (!askReviewLike) return '';

  const normalizedStore = normalizeStoreKey(targetStore);
  const sections = [];

  try {
    const r = await pool().query(
      `SELECT date::text AS date, review_type, product_name, service_item, content
       FROM bad_reviews
       WHERE lower(regexp_replace(store, '\\s+', '', 'g')) = $1
         AND date >= CURRENT_DATE - INTERVAL '30 days'
       ORDER BY date DESC
       LIMIT 200`,
      [normalizedStore]
    );
    const rows = Array.isArray(r.rows) ? r.rows : [];
    const recent7 = rows.filter((x) => {
      const d = toDateOnly(x?.date);
      if (!d) return false;
      return d >= toDateOnly(formatDate(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)));
    });

    if (!rows.length) {
      sections.push('【差评数据】近30天该门店无差评样本。');
    } else {
      const productTop = new Map();
      const serviceTop = new Map();
      rows.forEach((x) => {
        const p = String(x?.product_name || '').trim();
        const s = String(x?.service_item || '').trim();
        if (p) productTop.set(p, (productTop.get(p) || 0) + 1);
        if (s) serviceTop.set(s, (serviceTop.get(s) || 0) + 1);
      });
      const topN = (m) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}(${v})`).join('、') || '无';
      const samples = rows.slice(0, 3).map((x) => `- ${toDateOnly(x.date) || '-'}：${String(x.content || '').replace(/\s+/g, ' ').slice(0, 60)}`).join('\n');
      sections.push(
        `【差评数据】近7天${recent7.length}条，近30天${rows.length}条；产品Top：${topN(productTop)}；服务Top：${topN(serviceTop)}。\n最近样例：\n${samples}`
      );
    }
  } catch (e) {
    sections.push('【差评数据】查询失败或数据表不可用。');
  }

  try {
    const end = toDateOnly(new Date().toISOString());
    const start = toDateOnly(new Date(Date.now() - 29 * 86400000).toISOString());
    const rows = await loadUnifiedTableVisitRowsByStore(targetStore, start, end);
    if (!rows.length) {
      sections.push('【桌访数据】近30天无桌访不满意菜品样本。');
    } else {
      const itemTop = new Map();
      rows.forEach((x) => {
        extractTableVisitItems(x).forEach((k) => {
          itemTop.set(k, (itemTop.get(k) || 0) + 1);
        });
      });
      const top = Array.from(itemTop.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}(${v})`).join('、') || '无';
      sections.push(`【桌访数据】近30天样本${rows.length}条；不满意项Top：${top}`);
    }
  } catch (e) {
    sections.push('【桌访数据】查询失败或数据表不可用。');
  }

  return sections.join('\n');
}

async function buildBiDeterministicReviewReply(store, text) {
  const q = String(text || '').trim();
  const targetStore = String(store || '').trim();
  if (!targetStore) return '';
  if (!/(评价|差评|好评|评论)/.test(q)) return '';
  if (!/(多少|几条|总数|总评价|统计|上周|本周|昨天|昨日|今天|今日|近7天|7天)/.test(q)) return '';

  const normalizedStore = normalizeStoreKey(targetStore);
  const period = resolveDateRangeFromQuestion(q, 7);
  const periodLabel = period.label;

  try {
    const r = await pool().query(
      `SELECT COUNT(DISTINCT record_id)::int AS c
       FROM agent_messages
       WHERE content_type = 'negative_review'
         AND lower(regexp_replace(coalesce(agent_data->>'store',''), '\\s+', '', 'g')) = $1
         AND (
           CASE
             WHEN coalesce(agent_data->>'date','') ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (agent_data->>'date')::date
             WHEN coalesce(agent_data->>'date','') ~ '^\\d{10,13}$' THEN to_timestamp((agent_data->>'date')::bigint / CASE WHEN length(agent_data->>'date')=13 THEN 1000 ELSE 1 END)::date
             ELSE created_at::date
           END
         ) BETWEEN $2::date AND $3::date`,
      [normalizedStore, period.start, period.end]
    );
    const badCount = Number(r.rows?.[0]?.c || 0);
    return `${periodLabel}评价数据（${targetStore}）\n- 差评数：${badCount}条\n- 好评数：当前系统未接入“好评总量”数据源，无法给出\n- 总评价数：当前系统未接入“全量评价”数据源，无法给出\n\n如需“总评价/好评/差评占比”精确值，请接入平台全量评价表（大众点评/美团）后再查。`;
  } catch (e) {
    return `${periodLabel}评价数据暂不可用（查询异常）。当前仅保证“差评表”可统计，建议先检查差评表同步状态后重试。`;
  }
}

function checkAgentPermission(role, route) {
  const r = String(role || '').trim();
  const rt = String(route || '').trim();
  if (!r || !rt) return { allowed: true };
  if (r === 'admin' || r === 'hr_manager' || r === 'hq_manager') return { allowed: true };
  const ROUTE_ROLES = {
    data_auditor: ['store_manager', 'store_production_manager', 'cashier'],
    ops_supervisor: ['store_manager', 'store_production_manager'],
    chief_evaluator: ['store_manager', 'store_production_manager'],
    sop_advisor: ['store_manager', 'store_production_manager', 'cashier', 'staff'],
    appeal: ['store_manager', 'store_production_manager', 'cashier', 'staff'],
    appeal_agent: ['store_manager', 'store_production_manager', 'cashier', 'staff'],
    train_advisor: ['store_manager', 'store_production_manager', 'cashier', 'staff'],
    general: true
  };
  const allowed = ROUTE_ROLES[rt];
  if (allowed === true || !allowed) return { allowed: true };
  if (Array.isArray(allowed) && allowed.includes(r)) return { allowed: true };
  return { allowed: false, reason: `您的角色（${r}）暂无权限使用该功能，请联系管理员。` };
}

async function routeMessage(text, hasImage, senderUsername) {
  const t = String(text || '').trim();
  const ruleRoute = inferRouteByRules(t, hasImage);
  if (ruleRoute?.route && ruleRoute.route !== 'general') {
    return { route: ruleRoute.route, confidence: ruleRoute.confidence || 0.9, reason: ruleRoute.reason || 'rule_match' };
  }

  const explicitOpsKeywords = /(拍照|上传照片|巡检|检查表|开市检查|收档检查|开档检查|闭市检查)/;
  const explicitDataKeywords = /(桌访|差评|点评|大众点评|评价.*(怎么样|结果|情况|差|多少)|营业额|营收|生意|经营情况|经营|毛利|日报|业绩|达成率|目标.*营|客诉|kpi|人效|收档.*(得分|平均|合格|多少|几次|报告|数据)|开档.*(得分|平均|合格|多少|几次|报告|数据)|原料.*(异常|收货|多少|几次|报告|日报)|食材|进货|例会|早会|班会|报损|订单.*数|客单价|会员.*数|充值)/i;
  if (explicitDataKeywords.test(t) && !explicitOpsKeywords.test(t)) {
    return { route: 'data_auditor' };
  }
  
  // 快速通行：如果是单数字选项回复，直接返回general供后续继承历史路由
  if (/^\d+$/.test(t) || /^[一二三四五六七八九十]$/.test(t) || FOLLOWUP_HINT_PATTERNS.test(t)) {
    if (senderUsername) {
      const memory = await getAgentLongMemory(senderUsername, 'last_route');
      const memoryRoute = String(memory?.route || '').trim();
      if (memoryRoute && memoryRoute !== 'general') {
        return { route: memoryRoute, confidence: 0.86, reason: 'memory_followup' };
      }
    }
    return { route: 'general' };
  }

  // 获取最近的对话历史作为上下文（近30分钟内的最后3条非系统消息）
  let contextStr = '';
  if (senderUsername) {
    try {
      const historyRes = await pool().query(
        `SELECT content, direction FROM agent_messages WHERE sender_username = $1 AND content_type IN ('text', 'image') AND created_at > NOW() - INTERVAL '30 minutes' ORDER BY created_at DESC LIMIT 3`,
        [senderUsername]
      );
      if (historyRes.rows && historyRes.rows.length > 0) {
        const msgs = historyRes.rows.reverse().map(r => `${r.direction === 'in' ? '用户' : 'Agent'}: ${r.content}`);
        contextStr = `\n【最近对话上下文】\n${msgs.join('\n')}\n`;
      }
    } catch (e) {
      console.error('[route] history fetch error:', e?.message);
    }
  }

  const systemPrompt = `你是HRMS系统的主控路由Agent (Master Agent)。
你的唯一任务是根据用户的输入和对话上下文，决定将其路由给哪个专业的子Agent处理。
请严格输出JSON格式，必须包含以下三个字段，不要输出任何其他Markdown或散文：
{
  "route": "目标Agent标识符",
  "confidence": 0到1之间的置信度分数,
  "reason": "路由的简短理由，如果confidence低于0.7，请在这里填入反问用户的澄清话术（例如：您是想咨询财务问题还是技术问题？）"
}

可用Agent标识符及职责：
- data_auditor : 负责【数据审计】，如查询门店营收、毛利率、损耗、盘点、成本、差评数据、充值等数据分析。
- ops_supervisor : 负责【营运督导】，如开市收市检查、卫生巡检、图片审核、日常巡店检查表。
- chief_evaluator : 负责【HR与绩效】，如查询个人绩效分数、考核扣分、门店评级，以及离职、入职、请假、加薪等HR人事流程与制度咨询。
- train_advisor : 负责【培训与SOP】，如查阅SOP规范、操作指导、退款赔付流程，以及发起培训、查询课件、员工带教。
- appeal : 负责【申诉与投诉】，如员工对处罚扣分不服的申诉、对店长或同事的投诉举报。
- general : 如果无法明确归类到以上5个专业领域，或者只是简单的闲聊打招呼。

【Few-Shot 示例】
示例1:
用户输入: "我登不上系统了"
输出: {"route": "general", "confidence": 0.9, "reason": "系统登录问题不属于当前5个专业Agent，交由general处理"}
示例2:
用户输入: "我要投诉"
输出: {"route": "appeal", "confidence": 0.95, "reason": "明确包含投诉意图"}
示例3:
【最近对话上下文】
用户: 我要投诉
Agent: 请问你要投诉谁？
用户输入: "店长"
输出: {"route": "appeal", "confidence": 0.95, "reason": "结合上下文，用户在回复投诉对象，继续申诉流程"}
示例4:
用户输入: "帮我查一下那个单子"
输出: {"route": "general", "confidence": 0.4, "reason": "请问您是要查营收数据单、培训单，还是考勤异常单？"}
${contextStr}
当前用户输入: "${t}"
请严格返回JSON：`;

  try {
    const llm = await callLLM([
      { role: 'system', content: systemPrompt }
    ], { temperature: 0.1, max_tokens: 150, purpose: 'analysis' }); // 增加token以容纳JSON
    
    let resultText = String(llm.content || '').trim();
    // 移除可能包裹的 markdown JSON 标记
    resultText = resultText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();

    const result = safeJsonParse(resultText, null);
    if (!result || typeof result !== 'object') {
      console.error('[route] JSON parse failed, text:', resultText);
      return { route: 'general' };
    }
    
    const validRoutes = ['data_auditor', 'ops_supervisor', 'chief_evaluator', 'train_advisor', 'appeal', 'general'];
    
    // 置信度过滤
    if (result.confidence < 0.7 && result.reason) {
      if (ruleRoute?.route && ruleRoute.route !== 'general') {
        return { route: ruleRoute.route, confidence: ruleRoute.confidence || 0.9, reason: 'rule_override_low_confidence' };
      }
      return { route: 'clarify', message: result.reason };
    }
    
    if (validRoutes.includes(result.route)) {
      return { route: result.route };
    }
    return { route: 'general' };
  } catch (e) {
    console.error('[route] LLM routing failed, fallback to general:', e?.message);
    return { route: 'general' };
  }
}

// ─────────────────────────────────────────────
// 10. Agent Response Generator
// ─────────────────────────────────────────────

async function handleAgentMessage(senderUsername, senderName, senderStore, senderRole, senderBrandContext, text, imageUrls) {
  const hasImage = Array.isArray(imageUrls) && imageUrls.length > 0;
  let routeRes = await routeMessage(text, hasImage, senderUsername);
  let route = routeRes.route;
  
  if (route === 'clarify') {
    return prefixWithAgentName('master', routeRes.message || '请问您具体想咨询哪个方面的问题？');
  }

  let store = senderStore;

  // 【Q6】HQ/admin 用户的 store 通常为"总部"或空，从消息文本中提取门店名
  if (!store || store === '总部') {
    try {
      const storeR = await pool().query(`SELECT DISTINCT store FROM feishu_users WHERE store IS NOT NULL AND store != '' AND store != '总部'`);
      const knownStores = (storeR.rows || []).map(r => r.store).filter(Boolean);
      const txt = String(text || '');
      for (const s of knownStores) {
        if (txt.includes(s)) { store = s; break; }
      }
      // 模糊匹配品牌前缀（如"洪潮" → "洪潮大宁久光店"）
      if (!store || store === '总部') {
        for (const s of knownStores) {
          const prefix = txt.match(/(洪潮|马己仙|年年有喜)/)?.[0];
          if (prefix && s.includes(prefix)) { store = s; break; }
        }
      }
    } catch (e) {}
  }

  // 【Q5】查询用户近期活跃任务，注入上下文提升交互质量
  let activeTaskContext = '';
  try {
    const taskR = await pool().query(
      `SELECT task_id, category, severity, title, detail, status, created_at FROM master_tasks WHERE assignee_username=$1 AND status IN ('pending','pending_response','in_progress') ORDER BY created_at DESC LIMIT 3`,
      [senderUsername]
    );
    if (taskR.rows?.length) {
      activeTaskContext = '\n\n【该用户当前活跃任务】\n' + taskR.rows.map((t,i) => `${i+1}. [${t.severity||'medium'}] ${t.title}（状态:${t.status}，类别:${t.category}）${t.detail ? '\n   详情: '+String(t.detail).substring(0,100) : ''}`).join('\n');
    }
  } catch(e) {}
  
  // 【修复】继承上一轮的 Agent，解决多轮对话中断（例如用户回复选项 1, 2）的问题
  // 仅继承5分钟内的最近一条非general路由，避免跨对话污染
  if (route === 'general' && (/^\d+$/.test(text) || /^[一二三四五六七八九十]$/.test(text))) {
    try {
      const lastRouteResult = await pool().query(
        `SELECT routed_to FROM agent_messages WHERE sender_username = $1 AND direction = 'in' AND content_type IN ('text','image') AND routed_to IS NOT NULL AND routed_to != 'general' AND created_at > NOW() - INTERVAL '5 minutes' ORDER BY created_at DESC LIMIT 1`,
        [senderUsername]
      );
      if (lastRouteResult.rows && lastRouteResult.rows.length > 0) {
        route = lastRouteResult.rows[0].routed_to;
        console.log(`[route] Inherited recent route: ${route} for short input: ${text}`);
      }
    } catch (e) {
      console.error('[route] inherit route error:', e?.message);
    }
  }

  // ── HQ Brain 路由: 总部角色优先走决策大脑 ──
  try {
    console.log(`[agents] HQ Brain check: role=${senderRole}, text="${text?.slice(0, 40)}"`);
    const hqResult = await handleHqBrainMessage({
      text, role: senderRole, username: senderUsername, store
    });
    if (hqResult?.handled) {
      console.log(`[agents] HQ Brain handled: ${hqResult.response?.slice(0, 60)}`);
      return prefixWithAgentName('master', hqResult.response || '');
    }
  } catch (e) {
    console.error('[agents] HQ Brain routing error:', e?.message, e?.stack?.split('\n')[1]);
  }

  // 检查是否为培训任务审批（管理员审核下发）
  if (text.includes('审核通过') && text.includes('下发') && (senderRole === 'admin' || senderRole === 'hr_manager')) {
    const pendingTasks = await pool().query(
      `SELECT * FROM training_tasks WHERE status = 'pending_approval' ORDER BY updated_at DESC LIMIT 1`
    );
    if (pendingTasks.rows && pendingTasks.rows.length > 0) {
      const task = pendingTasks.rows[0];
      await pool().query(`UPDATE training_tasks SET status = 'pending', updated_at = NOW() WHERE id = $1`, [task.id]);
      return `已将【${task.title}】的培训任务加入调度队列，Master 将尽快推送给 ${task.assignee_username} 进行学习。`;
    }
  }

  // 检查是否为培训考核消息
  if (text.includes('开始考核') || text.includes('培训考核')) {
    const tasks = await pool().query(
      `SELECT * FROM training_tasks WHERE assignee_username = $1 AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1`,
      [senderUsername]
    );
    if (tasks.rows && tasks.rows.length > 0) {
      const task = tasks.rows[0];
      return `收到！您正在进行【${task.title}】的考核。请回答以下问题：\n\n1. 针对本课程，您认为最重要的三个实操要点是什么？\n2. 在实际工作场景中，您会如何应用所学内容？\n\n请直接回复您的答案，我将为您进行评估。`;
    }
  }

  // 检查是否为培训答卷提交
  if (text.includes('1.') && text.includes('2.') && route === 'train_advisor') {
    const tasks = await pool().query(
      `SELECT * FROM training_tasks WHERE assignee_username = $1 AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1`,
      [senderUsername]
    );
    if (tasks.rows && tasks.rows.length > 0) {
      const task = tasks.rows[0];
      
      // Train Agent 评估成绩（这里简化逻辑，通常可以用 LLM 评估）
      const passed = text.length > 20; // 简单判断回答字数
      
      if (passed) {
        // 更新任务状态为已完成
        await pool().query(
          `UPDATE training_tasks SET status = 'completed', completed_at = NOW(), progress_data = jsonb_set(progress_data, '{exam_answer}', $1::jsonb) WHERE id = $2`,
          [JSON.stringify(text), task.id]
        );
        
        // 将结果记入个人档案 (写入 exam_results)
        await pool().query(
          `INSERT INTO exam_results (user_key, score, pass, created_at) VALUES ($1, $2, $3, NOW())`,
          [senderUsername, 100, true]
        );

        // 反馈给 Chief Evaluator，增加绩效积分 (写入 master_tasks 作为加分项)
        const evalTaskId = `EVAL-${Date.now().toString().slice(-6)}-${Math.random().toString(36).slice(2, 6)}`;
        await pool().query(
          `INSERT INTO master_tasks (task_id, status, source, category, severity, store, brand, title, assignee_username, score_impact, current_agent)
           VALUES ($1, 'settled', 'train_agent', '培训加分', 'low', $2, $3, $4, $5, 5, 'chief_evaluator')`,
          [evalTaskId, task.store, task.brand, `完成培训考核：${task.title}`, senderUsername]
        );

        return `✅ 恭喜您，【${task.title}】考核通过！\n\n您的评估结果已记入 HRMS 个人培训档案，并将同步反馈至您的当周绩效中（+5分）。继续保持！`;
      } else {
        return `❌ 【${task.title}】考核未通过。\n\n您的回答过于简短，请结合实际工作场景，重新详细回答以上两个问题。`;
      }
    }
  }

  // 检查是否为毛利率消息
  if (text.includes('毛利率') && text.includes('%')) {
    try {
      const result = await handleMarginMessage(text);
      if (result.success) {
        return `毛利率数据已收到并保存：${JSON.stringify(result)}`;
      }
    } catch (e) {
      console.error('[agents] margin message error:', e?.message);
    }
  }
  
  const brand = String(senderBrandContext?.brandName || '').trim();
  const brandId = String(senderBrandContext?.brandId || '').trim();
  const brandTag = brandId ? `brand:${brandId}` : '';
  const brandConfig = getBrandRuntimeConfig(await getSharedState(), senderBrandContext);

  let response = '';
  let agentData = { route, brandId, brandConfig };

  try {
    switch (route) {
      case 'data_auditor': {
        const deterministicCoverageReply = await buildBiDeterministicDataSourceCoverageReply(text);
        if (deterministicCoverageReply) {
          response = deterministicCoverageReply;
          agentData = { route, store, brand, brandId, brandConfig, grounded: true, deterministic: true, source: 'bi_data_source_coverage' };
          break;
        }

        const fcHandled = await tryHandleBiByFunctionCalling({
          text,
          store,
          brand,
          senderRole,
          senderUsername
        });
        if (fcHandled?.response) {
          response = fcHandled.response;
          agentData = {
            route,
            store,
            brand,
            brandId,
            brandConfig,
            deterministic: true,
            functionCalling: true,
            ...fcHandled.meta
          };
          break;
        }

        const deterministicDailyReportReply = await buildBiDeterministicDailyReportReply(store, text);
        if (deterministicDailyReportReply) {
          response = deterministicDailyReportReply;
          agentData = { route, store, brand, brandId, brandConfig, grounded: true, deterministic: true, source: 'daily_reports' };
          break;
        }

        const deterministicTableVisitReply = await buildBiDeterministicTableVisitReply(store, text);
        if (deterministicTableVisitReply) {
          response = deterministicTableVisitReply;
          agentData = { route, store, brand, brandId, brandConfig, grounded: true, deterministic: true, source: 'table_visit' };
          break;
        }

        const deterministicSalesRawTopReply = await buildBiDeterministicSalesRawTopReply(store, text);
        if (deterministicSalesRawTopReply) {
          response = deterministicSalesRawTopReply;
          agentData = { route, store, brand, brandId, brandConfig, grounded: true, deterministic: true, source: 'sales_raw' };
          break;
        }

        // 预测备货销售明细（堂食/外卖×时段销量占比）
        if (/(堂食|外卖|销售明细|时段.*销|销.*时段|午市|晚市|菜品.*销量|销量.*排|热销|畅销|备货|点单)/.test(String(text||''))) {
          try {
            const st = await getSharedState();
            const allH = Array.isArray(st?.inventoryForecastHistory) ? st.inventoryForecastHistory : [];
            const storeH = allH.filter(x => normalizeStoreKey(x?.store) === normalizeStoreKey(store));
            if (storeH.length) {
              const p = resolveDateRangeFromQuestion(text, 7);
              const filt = storeH.filter(x => { const d=String(x?.date||''); return d>=p.start&&d<=p.end; });
              if (filt.length) {
                const rpt = buildSalesReport(filt, store, p);
                if (rpt) { response = rpt; agentData = { route, store, brand, brandId, brandConfig, grounded: true, deterministic: true, source: 'inventory_forecast' }; break; }
              } else {
                const dates = storeH.map(x=>x?.date).filter(Boolean).sort();
                response = `📦 ${p.label}暂无销售明细数据（${store}）。已有数据范围：${dates[0]} ~ ${dates[dates.length-1]}`;
                agentData = { route, store, brand, brandId, brandConfig, grounded: true, deterministic: true, source: 'inventory_forecast' }; break;
              }
            }
          } catch(e) { console.error('[bi] sales detail error:', e?.message); }
        }

        const deterministicOpsCountReply = await buildBiDeterministicOpsReportCountReply(store, text);
        if (deterministicOpsCountReply) {
          response = deterministicOpsCountReply;
          agentData = { route, store, brand, brandId, brandConfig, grounded: true, deterministic: true, source: 'ops_reports' };
          break;
        }

        const deterministicBadReviewReply = await buildBiDeterministicBadReviewReportReply(store, text);
        if (deterministicBadReviewReply) {
          response = deterministicBadReviewReply;
          agentData = { route, store, brand, brandId, brandConfig, grounded: true, deterministic: true, source: 'bad_reviews' };
          break;
        }

        const deterministicClosingReply = await buildBiDeterministicClosingReportReply(store, text);
        if (deterministicClosingReply) {
          response = deterministicClosingReply;
          agentData = { route, store, brand, brandId, brandConfig, grounded: true, deterministic: true, source: 'closing_reports' };
          break;
        }

        const deterministicOpeningReply = await buildBiDeterministicOpeningReportReply(store, text);
        if (deterministicOpeningReply) {
          response = deterministicOpeningReply;
          agentData = { route, store, brand, brandId, brandConfig, grounded: true, deterministic: true, source: 'opening_reports' };
          break;
        }

        const deterministicMaterialReply = await buildBiDeterministicMaterialReportReply(store, text);
        if (deterministicMaterialReply) {
          response = deterministicMaterialReply;
          agentData = { route, store, brand, brandId, brandConfig, grounded: true, deterministic: true, source: 'material_reports' };
          break;
        }

        const deterministicMeetingReply = await buildBiDeterministicMeetingReportReply(store, text);
        if (deterministicMeetingReply) {
          response = deterministicMeetingReply;
          agentData = { route, store, brand, brandId, brandConfig, grounded: true, deterministic: true, source: 'meeting_reports' };
          break;
        }

        const deterministicLossReply = await buildBiDeterministicLossReportReply(store, text);
        if (deterministicLossReply) {
          response = deterministicLossReply;
          agentData = { route, store, brand, brandId, brandConfig, grounded: true, deterministic: true, source: 'loss_reports' };
          break;
        }

        const isFactQuestion = isFactLikeQuestion(text);
        const sourceAuditRows = isFactQuestion ? await buildBiFactSourceAudit(store, text) : [];
        const hasUsableSource = sourceAuditRows.some((x) => x.status === 'ok');
        if (isFactQuestion && sourceAuditRows.length > 0 && !hasUsableSource) {
          const auditText = buildBiSourceAuditText(sourceAuditRows);
          response = `当前问题需要的数据源暂无可用样本，无法给出确定性结论。\n\n数据源检查：\n${auditText}\n\n请先完成数据同步/启用后重试。`;
          agentData = { route, store, brand, brandId, brandConfig, grounded: false, reason: 'insufficient_sources', sourceAuditRows };
          break;
        }

        // 先查异常数据作为上下文
        let issueContext = '';
        try {
          const issuesR = await pool().query(
            `SELECT severity, title, created_at FROM agent_issues WHERE store = $1 AND status != 'resolved' ORDER BY created_at DESC LIMIT 5`, [store]
          );
          if (issuesR.rows?.length) {
            issueContext = '\n\n当前门店未解决的审计异常：\n' + issuesR.rows.map((i, idx) => `${idx+1}. [${i.severity}] ${i.title}`).join('\n');
          }
        } catch (e) {}

        const groundingFacts = await buildBiGroundingFacts(store, text);
        const sourceAuditText = buildBiSourceAuditText(sourceAuditRows);
        const hasInsufficientFacts = /无差评样本|无桌访不满意菜品样本|查询失败|不可用/.test(groundingFacts);
        const askReviewLike = /(差评|点评|评论|桌访|产品问题|反馈|口味|出品|上菜|服务)/.test(String(text || ''));

        if (askReviewLike && hasInsufficientFacts && !issueContext) {
          response = '当前系统可用样本不足，暂时无法给出准确的“近7天差评/桌访问题次数”结论。建议先确认飞书差评表与桌访表是否已入库，再让我输出精确明细（含桌号/时段/原文）。';
          agentData = { route, store, brand, brandId, brandConfig, grounded: false, reason: 'insufficient_facts' };
          break;
        }

        const biLlm = await callLLM([
          { role: 'system', content: `你是"小年"，年年有喜餐饮集团AI助理，当前协助数据分析。当前时间：${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}。门店：${store}（${brand}）。用户：${senderName}（${senderRole === 'store_manager' ? '店长' : senderRole === 'store_production_manager' ? '出品经理' : '员工'}）。
数据说明：系统中"expectedRevenue"=折前营业额（销售金额），"actualRevenue"=实收营业额（菜品收入）。洪潮品牌仅堂食，无外卖业务。
严格约束：只能基于下方事实作答，绝对禁止编造数字/日期/菜品排名。若无事实必须说"当前系统无此数据"。禁止提及"卤鹅"为热销菜品。禁止编造员工人数/薪资日期等非BI信息。
${issueContext}${activeTaskContext}
${sourceAuditText ? '数据源：'+sourceAuditText : ''}
${groundingFacts ? '可用事实：'+groundingFacts : ''}
严格基于事实回复，不超300字。` },
          ...getContext(senderUsername).slice(-4),
          { role: 'user', content: text }
        ], { role: senderRole, purpose: 'analysis', temperature: 0.05, max_tokens: 420 });
        response = biLlm.content || '收到，我会查看门店数据并尽快回复。';
        updateContext(senderUsername, 'user', text);
        updateContext(senderUsername, 'assistant', response);
        agentData = { route, store, brand, brandId, brandConfig, sourceAuditRows, grounded: !!groundingFacts, groundingFacts };
        break;
      }

      case 'ops_supervisor': {
        if (hasImage) {
          const auditResults = [];
          for (const imgUrl of imageUrls) {
            const result = await auditImage(imgUrl, 'general', { store, brand, username: senderUsername });
            auditResults.push(result);
          }
          const anyDuplicate = auditResults.some(r => r.duplicate);
          const allPass = auditResults.every(r => r.result === 'pass');
          const anyFail = auditResults.some(r => r.result === 'fail');

          if (anyDuplicate) {
            response = `⚠️ 检测到重复图片，请重新拍摄并上传。系统已记录此次异常。`;
          } else if (allPass) {
            const summaries = auditResults.map(r => r.findings).filter(Boolean).join('；');
            response = `收到，照片识别合格 ✅\n${summaries || '图片内容符合要求。'}\n已记录整改措施，感谢配合。`;
          } else if (anyFail) {
            const failFindings = auditResults.filter(r => r.result === 'fail').map(r => r.findings).join('；');
            response = `照片审核未通过 ❌\n${failFindings}\n请整改后重新拍照上传。`;
          } else {
            response = `照片已收到，正在审核中。部分图片无法自动判定，已转交值班经理人工复核。`;
          }
          agentData = { route, auditResults, brandId, brandConfig };
        } else {
          let knowledgeSupport = null;
          // 检查是否为检查表请求
          let checklistResponse = '';
          
          if (text.includes('开市') || text.includes('开档')) {
            const items = brand === '洪潮' 
              ? ['地面清洁无积水', '所有设备正常开启', '食材新鲜度检查', '餐具消毒完成', '灯光亮度适中', '背景音乐开启', '空调温度设置合适', '员工仪容仪表检查']
              : brand === '马己仙'
              ? ['地面清洁', '设备开启', '食材准备', '餐具消毒', '迎宾准备']
              : ['地面清洁', '设备开启', '食材准备', '餐具消毒'];
            checklistResponse = `📋 开市检查表（${brand} · ${store}）\n\n检查项目：\n${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}\n\n请逐项完成后拍照发送至本对话。`;
          } else if (text.includes('收档') || text.includes('闭市') || text.includes('收市')) {
            const items = brand === '洪潮'
              ? ['食材封存', '设备关闭', '垃圾清理', '安全检查', '门窗锁好']
              : brand === '马己仙'
              ? ['食材封存', '设备关闭', '垃圾清理', '安全检查', '门窗锁好', '电源关闭']
              : ['食材封存', '设备关闭', '垃圾清理', '安全检查'];
            checklistResponse = `📋 收档检查表（${brand} · ${store}）\n\n检查项目：\n${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}\n\n请逐项完成后拍照发送至本对话。`;
          } else if (text.includes('巡检')) {
            checklistResponse = `📋 营运巡检（${store}）\n\n检查项目：\n1. 大厅环境整洁\n2. 服务台规范\n3. 卫生间清洁\n4. 后厨卫生\n5. 安全设施\n\n请拍照发送至本对话。`;
          }
          
          if (checklistResponse) {
            response = checklistResponse;
          } else {
            // 检查是否需要知识支援
            knowledgeSupport = await getOpsKnowledgeSupport(text, { store, brand });
            
            if (knowledgeSupport.type === 'standard' || knowledgeSupport.type === 'knowledge_base') {
              response = knowledgeSupport.response;
            } else {
              // 使用LLM生成专业回复
              const llm = await callLLM([
                { role: 'system', content: `你是"小年"，年年有喜餐饮集团AI助理，当前协助营运检查。当前时间：${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}。门店：${store}（${brand}）。简洁专业，注重实操。严格约束：禁止编造任何数据（员工人数、日期等），无数据时说明"暂无数据"。${activeTaskContext}` },
                { role: 'user', content: text }
              ], { model: getOpsReasoningModel(), role: senderRole, purpose: 'reasoning', temperature: 0.05, max_tokens: 360 });
              response = llm.content || '收到，我会跟进处理。';
            }
          }
          
          agentData = { route, knowledgeSupport: knowledgeSupport?.type, brandId, brandConfig };
        }
        break;
      }

      case 'chief_evaluator': {
        // 判断是否在问绩效分数（走数据查询），还是HR流程问题（走LLM）
        const isScoreQuery = /分数|绩效|考核|得分|扣分|排名|评价|评级|奖金/.test(text);

        // 获取员工资料上下文（权限控制：店长可查本店员工，HR/admin可查全部）
        let employeeContext = '';
        try {
          const hrState = await getSharedState();
          const allEmps = Array.isArray(hrState?.employees) ? hrState.employees : (Array.isArray(hrState?.data?.employees) ? hrState.data.employees : []);
          const canSeeAll = ['admin', 'hr_manager', 'hq_manager'].includes(senderRole);
          const visibleEmps = canSeeAll ? allEmps.filter(e => e.status === 'active') : allEmps.filter(e => e.status === 'active' && e.store === store);
          if (visibleEmps.length > 0) {
            const roleLabel = { admin: '管理员', store_manager: '店长', store_production_manager: '出品经理', store_employee: '员工', hr_manager: 'HR', hq_manager: '总部营运', cashier: '出纳' };
            employeeContext = '\n\n当前可查询的员工资料（共' + visibleEmps.length + '人）：\n' + visibleEmps.map(e => `- ${e.name}（${e.username}）| ${roleLabel[e.role] || e.role} | ${e.store || '总部'} | ${e.position || '-'} | ${e.department || '-'}`).join('\n');
          }
        } catch (e) {}
        
        if (isScoreQuery) {
          // 绩效查询：查数据库
          const scoresR = await pool().query(
            `SELECT * FROM agent_scores WHERE username = $1 ORDER BY created_at DESC LIMIT 1`, [senderUsername]
          );
          const score = scoresR.rows?.[0];
          if (score) {
            const bd = score.breakdown || {};
            const storeRatingText = bd.store_rating ? `${bd.store_rating}级` : '-';
            const execRatingText = bd.execution_rating ? `${bd.execution_rating}级` : '-';
            const attRatingText = bd.attitude_rating ? `${bd.attitude_rating}级` : '-';
            const abiRatingText = bd.ability_rating ? `${bd.ability_rating}级` : '-';
            
            response = `HR: ${senderName}，你在${score.store}（${score.brand}）的最新考核：\n\n📊 绩效得分：${score.total_score} 分\n🏪 门店评级：${storeRatingText}\n📈 执行力：${execRatingText}\n💪 工作态度：${attRatingText}\n🎯 工作能力：${abiRatingText}\n\n${score.summary || ''}`;
          } else {
            response = `${senderName}，暂无你的考核记录。考核将在月末自动生成。`;
          }
        } else {
          // HR流程问题：用LLM回答（带Check Agent质检）
          const hrSystemPrompt = `你是"小年"，年年有喜餐饮集团AI助理，当前协助人事管理。当前时间：${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}。门店：${store}（${brand}）。用户：${senderName}（${senderRole === 'store_manager' ? '店长' : senderRole === 'store_production_manager' ? '出品经理' : '员工'}）。\n\n职责：离职/入职/转正/晋升/调岗流程、薪资咨询、请假/休假/考勤、社保/档案、绩效规则、员工信息查询。\n\n严格约束：\n- 只能基于下方员工资料回答员工相关问题，禁止编造不在列表中的员工信息。\n- 禁止编造日期，当前真实日期以上方为准。\n- 可以说明一般流程和政策框架，但涉及具体数字必须基于数据。\n回复不超过300字。${employeeContext}${activeTaskContext}`;
          const hrContext = getContext(senderUsername).slice(-4);
          response = await runWithCheckAgent(text, 'chief_evaluator', async (checkFeedback) => {
            const extraNote = checkFeedback ? `\n\n【质检反馈，请修正后重新回答】${checkFeedback}` : '';
            const hrLlm = await callLLM([
              { role: 'system', content: hrSystemPrompt + extraNote },
              ...hrContext,
              { role: 'user', content: text }
            ], { role: senderRole, purpose: 'reasoning', temperature: 0.05, max_tokens: 420 });
            return hrLlm.content || '收到，我会为您查询相关信息并尽快回复。';
          });
          updateContext(senderUsername, 'user', text);
          updateContext(senderUsername, 'assistant', response);
        }
        agentData = { route, brandId, brandConfig, dataBacked: isScoreQuery };
        break;
      }

      case 'appeal': {
        const appealSystemPrompt = `你是"小年"，年年有喜餐饮集团AI助理，当前协助投诉与申诉处理。当前时间：${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}。
1. 投诉（对店长、同事、服务等）：确认内容，转交负责人核实，保护隐私，给出流程和预计时间。
2. 申诉（对绩效扣分、处罚等）：确认内容，核实数据，给出预计处理时间。
严格约束：禁止编造任何数据（员工人数、日期等），无数据时说"暂无此信息"。回复专业、公正、简短。${activeTaskContext}`;
        const appealContext = getContext(senderUsername);
        const appealUserMsg = `${senderName}（${store}门店，${senderRole === 'store_manager' ? '店长' : senderRole === 'store_production_manager' ? '出品经理' : '员工'}）说：${text}`;
        response = await runWithCheckAgent(text, 'appeal', async (checkFeedback) => {
          const extraNote = checkFeedback ? `\n\n【质检反馈，请修正后重新回答】${checkFeedback}` : '';
          const llm = await callLLM([
            { role: 'system', content: appealSystemPrompt + extraNote },
            ...appealContext,
            { role: 'user', content: appealUserMsg }
          ], { role: senderRole, purpose: 'reasoning', temperature: 0.05, max_tokens: 360 });
          return llm.content || '已记录，我们将在24小时内核实并回复。';
        });
        try {
          await pool().query(`INSERT INTO agent_appeals (username, reason, status) VALUES ($1, $2, 'pending')`, [senderUsername, text]);
        } catch (e) {}
        agentData = { route, appealRecorded: true };
        break;
      }

      case 'train_advisor':
      case 'sop_advisor': {
        // Query knowledge base for relevant SOP & training content
        let kbContext = '';
        let kbResults = [];
        try {
          kbResults = await queryKnowledgeBase(['sop', '流程', '标准', '规范', '培训', '课件', '带教'], text, 3, { brandTag });
          if (kbResults.length) {
            kbContext = '\n\n相关知识库内容：\n' + 
              kbResults.map(r => `【${r.title}】${String(r.content || '').slice(0, 300)}...`).join('\n');
          }
        } catch (e) {}

        // 查阅该用户的培训记录
        let trainingTasksContext = '';
        try {
          const tasks = await pool().query(
            `SELECT task_id, type, title, status, due_date, progress_data FROM training_tasks 
             WHERE assignee_username = $1 ORDER BY created_at DESC LIMIT 5`,
            [senderUsername]
          );
          if (tasks.rows && tasks.rows.length > 0) {
            trainingTasksContext = '\n\n该用户近期的培训任务：\n' + tasks.rows.map(t => 
              `- [${t.task_id}] ${t.title} (${t.type}) | 状态：${t.status} | 截止：${t.due_date ? new Date(t.due_date).toLocaleDateString() : '无'}`
            ).join('\n');
          }
        } catch (e) {
          console.error('[train_advisor] fetch training tasks error:', e?.message);
        }

        // 构建增强的prompt（SOP + 培训双能力）
        const trainingFocusText = brandConfig?.trainingFocus?.length ? `\n品牌培训重点：${brandConfig.trainingFocus.join('；')}` : '';
        const systemPrompt = `你是"小年"，年年有喜餐饮集团AI助理，当前协助培训与标准化咨询。当前时间：${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}。严格约束：禁止编造任何数据（员工人数、薪资日期等），无数据时说明"暂无此信息"。严格执行品牌隔离。${brandConfig?.sopKeypoints?.length ? `\n品牌SOP关键点：${brandConfig.sopKeypoints.join('；')}` : ''}${trainingFocusText}

你的核心能力：
【SOP标准咨询】流程规范查询、操作指导、赔付退款处理、品牌差异化SOP
【培训战略体系】制定培训战略、搭建人才发展与梯队培养框架、领导力发展、管培生/内训师体系设计、年度培训预算与计划、对接业务部门做培训需求分析、主导管理层培训与关键岗位赋能、企业文化落地、管理培训团队与讲师资源、评估培训效果与ROI
【基础培训执行】组织新员工入职培训与岗位技能培训、制作整理更新培训课件资料、安排培训场地设备签到与现场支持、收集培训反馈记录培训数据归档、协助完成培训计划与通知下发、对接讲师学员保障培训正常开展
【培训跟踪评估】跟进员工的培训任务进度，解答培训过程中的疑惑，进行线上知识考核与效果评估

当前信息：
- 门店：${store}（${brand}，brand_id=${brandId || 'n/a'}）
- 用户：${senderName}（${senderUsername}，角色：${senderRole}）
- 查询：${text}

${kbContext}${trainingTasksContext}${activeTaskContext}

请根据问题类型选择合适的回复结构：
如果是SOP/流程问题：
1. **问题判断**：简要确认理解的问题
2. **标准流程**：分步骤说明具体操作（1-2-3格式）
3. **注意事项**：关键提醒和常见错误
4. **参考依据**：相关SOP条款或标准

如果是培训咨询/任务问题：
1. **进度跟进**：结合用户的培训任务，指出当前进度或待办
2. **专业解答**：解答用户关于课件或技能的疑惑
3. **下一步建议**：给出接下来的学习或实操建议
4. **效果评估**：如果是完成阶段，可以向用户提问1-2个关键知识点进行检验

要求：简洁实用，总回复不超过400字。`;

        const contextHistory = getContext(senderUsername);
        const messages = [
          { role: 'system', content: systemPrompt },
          ...contextHistory.slice(-4), // 最近4轮对话
          { role: 'user', content: text }
        ];

        const llm = await callLLM(messages, { role: senderRole, purpose: 'reasoning', temperature: 0.05, max_tokens: 800 });
        response = llm.content || '这个问题我需要查阅最新的SOP手册或培训资料，稍后回复你。';
        
        // 更新上下文
        updateContext(senderUsername, 'user', text);
        updateContext(senderUsername, 'assistant', response);
        
        agentData = { route: 'train_advisor', kbResults: kbResults.length, contextUsed: contextHistory.length, brandId, brandConfig };
        break;
      }

      default: {
        const roleText = senderRole === 'store_manager' ? '店长' : senderRole === 'store_production_manager' ? '出品经理' : '员工';

        const llm = await callLLM([
          { role: 'system', content: `你是"小年"，年年有喜餐饮集团的AI助理。当前时间：${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}。门店：${store}（${brand}）。用户：${roleText}（${senderName}）。

可以帮助：数据审计、营运检查、绩效查询、SOP咨询、申诉处理。

严格约束：
- 禁止编造任何数据（员工人数、薪资日期、职级、品牌数等），如无确切数据必须回复"这个信息我暂时无法查到，建议联系HR或查看系统"。
- 禁止编造日期，当前真实日期以上方为准。
- 如果用户有活跃任务且在提问，结合任务背景给出专业指导。
回复极其简短。${activeTaskContext}` },
          ...getContext(senderUsername),
          { role: 'user', content: text }
        ], { role: senderRole, purpose: 'reasoning', temperature: 0.05, max_tokens: 260 });
        response = llm.content || '收到你的消息。你可以问我数据审计、营运检查、绩效考核等问题，也可以直接发照片给我审核。';
        agentData = { route: 'general', contextUsed: getContext(senderUsername).length, brandId };
        break;
      }
    }
  } catch (e) {
    console.error('[agents] handleAgentMessage error:', e?.message || e);
    response = '抱歉，处理消息时出现错误，请稍后重试。';
    agentData = { route, error: String(e?.message || e) };
  }

  const factDemand = detectFactDemand(text);
  if (factDemand === 'hard' && !isDataBackedReply(agentData)) {
    response = FACTUAL_DATA_UNAVAILABLE_MESSAGE;
    agentData = { ...agentData, factualGuardrailBlocked: true, factDemand };
    markQualityMetric('factualBlocks', 1);
  } else {
    agentData = { ...agentData, factDemand };
  }

  try {
    const qg = await enforceUnifiedQualityGate({
      userQuery: text,
      route,
      response,
      agentData,
      senderUsername,
      senderRole,
      store,
      brand
    });
    response = qg.response;
    agentData = qg.agentData;
  } catch (e) {
    console.error('[agents] enforceUnifiedQualityGate error:', e?.message || e);
  }

  const evidence = buildEvidencePackage(agentData, { route, store, brand });
  agentData = {
    ...agentData,
    route,
    store,
    brand,
    evidence,
    sourceCoverage: computeSourceCoverage(agentData),
    confidence: computeResponseConfidence(route, response, agentData)
  };

  try {
    await setAgentLongMemory(senderUsername, 'last_route', {
      route,
      store,
      brand,
      confidence: agentData.confidence,
      updatedAt: new Date().toISOString()
    });
  } catch (e) {}

  const needsAutonomousTask = !!(
    agentData?.factualGuardrailBlocked ||
    agentData?.reason === 'insufficient_sources' ||
    agentData?.reason === 'insufficient_facts' ||
    agentData?.numericGroundingBlocked
  );
  if (needsAutonomousTask && store && store !== '总部') {
    try {
      const state = await getSharedState();
      const owner = await findStoreManager(state, store);
      const task = await createOrUpdateAutonomousDataTask({
        taskType: 'data_gap',
        store,
        brand,
        requesterUsername: senderUsername,
        route,
        queryText: text,
        reason: String(agentData?.reason || (agentData?.factualGuardrailBlocked ? 'factual_guardrail_blocked' : 'insufficient_evidence')).slice(0, 120),
        evidence,
        ownerUsername: owner || '',
        dueHours: 8
      });
      if (task) {
        agentData.autonomousTaskId = task.id;
        notifyAutonomousDataTaskOwner(task).catch(() => {});
      }
    } catch (e) {
      console.error('[agents] autonomous data-gap task failed:', e?.message || e);
    }
  }

  return { route, response, agentData };
}

// ─────────────────────────────────────────────
// 11. Check Agent - Self-Reflection Quality Gate
// ─────────────────────────────────────────────

function fallbackQualityAudit(userQuery, agentResponse) {
  const q = normalizePlainText(userQuery || '', 300);
  const a = normalizePlainText(agentResponse || '', 1200);
  let accuracy = 6;
  let relevance = 6;
  let tone = 7;

  if (!a) {
    return {
      accuracy: 2,
      relevance: 2,
      tone: 5,
      total: 3,
      pass: false,
      feedback: '回答为空，请直接回答用户问题并给出可执行下一步。'
    };
  }

  if (a.length < 20) relevance -= 2;
  if (/抱歉|稍后|无法|不清楚/.test(a) && /(多少|排名|趋势|分析|绩效|SOP)/.test(q)) relevance -= 2;
  if (/不知道|随便|你看着办/.test(a)) tone -= 3;
  if (/\d/.test(q) && !/\d/.test(a) && detectFactDemand(q) === 'hard') accuracy -= 2;

  const total = Number(((accuracy + relevance + tone) / 3).toFixed(1));
  return {
    accuracy,
    relevance,
    tone,
    total,
    pass: total >= 7,
    feedback: total >= 7 ? '' : '请更贴合问题、补充关键事实或明确说明缺失数据来源。'
  };
}

async function checkAgentAudit(userQuery, agentResponse, route, options = {}) {
  const evidenceText = String(options?.evidenceText || '').trim();
  const role = String(options?.role || '').trim();
  const auditPrompt = `你是HRMS系统的质检Agent（Check Agent）。你的任务是审核子Agent的回答质量。

【用户问题】
${userQuery}

【子Agent（${route}）的回答】
${agentResponse}

请从以下3个维度评分（每项1-10分），并给出综合判断：
1. **准确性**：回答是否基于事实，有无幻觉或编造内容？
2. **相关性**：回答是否真正解决了用户的问题？
3. **语气**：语气是否专业、得当、不冷漠也不过度？

请严格输出JSON格式：
{
  "accuracy": 分数,
  "relevance": 分数,
  "tone": 分数,
  "total": 综合分数(三项平均),
  "pass": true或false（total>=7为pass）,
  "feedback": "如果不通过，给出具体的修改建议，指出哪里有问题以及如何改进"
}

补充要求：
- 如果回答中出现数字/比例/排名，请检查是否与可用事实一致
- 若“可用事实”为空，不得鼓励编造，请要求明确说明数据缺失

【可用事实】
${evidenceText || '暂无'}

仅返回JSON。`;

  try {
    const llm = await callLLM([
      { role: 'system', content: auditPrompt }
    ], { temperature: 0.05, max_tokens: 420, role, purpose: 'analysis', skipCache: true });

    const parsed = safeJsonParse(llm.content || '', null);
    if (parsed && typeof parsed === 'object') {
      const total = Number(parsed.total);
      return {
        accuracy: Number(parsed.accuracy) || 0,
        relevance: Number(parsed.relevance) || 0,
        tone: Number(parsed.tone) || 0,
        total: Number.isFinite(total) ? total : Number((((Number(parsed.accuracy) || 0) + (Number(parsed.relevance) || 0) + (Number(parsed.tone) || 0)) / 3).toFixed(1)),
        pass: parsed.pass !== false,
        feedback: String(parsed.feedback || '').trim()
      };
    }
    return fallbackQualityAudit(userQuery, agentResponse);
  } catch (e) {
    console.error('[check_agent] audit error:', e?.message);
    return fallbackQualityAudit(userQuery, agentResponse);
  }
}

async function rewriteResponseByAudit({ userQuery, response, route, feedback, evidenceText, role }) {
  const llm = await callLLM([
    {
      role: 'system',
      content: `你是HRMS回复重写器。请在不编造事实的前提下重写回答。
要求：
1) 优先回应用户核心问题
2) 仅使用可用事实，不得新增数据
3) 不超过280字，语言专业直接
4) 若事实不足，明确写“当前系统无此数据”，并给下一步建议
可用事实：${evidenceText || '暂无'}
质检反馈：${feedback || '无'}`
    },
    { role: 'user', content: `用户问题：${String(userQuery || '')}\n原回答：${String(response || '')}` }
  ], {
    temperature: 0.05,
    max_tokens: 420,
    role,
    purpose: 'reasoning',
    skipCache: true
  });
  return normalizePlainText(llm?.content || response || '', 1500) || String(response || '');
}

async function runWithCheckAgent(userQuery, route, generateFn, maxRetries = 2) {
  let response = await generateFn(null);
  
  // 仅对关键Agent启用Check Agent（避免增加general/ops的延迟）
  const checkEnabledRoutes = ['chief_evaluator', 'data_auditor', 'appeal', 'train_advisor'];
  if (!checkEnabledRoutes.includes(route)) return response;

  let lastAudit = null;
  let rewriteCount = 0;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const audit = await checkAgentAudit(userQuery, response, route);
    lastAudit = audit;
    console.log(`[check_agent] route=${route} attempt=${attempt + 1} pass=${audit.pass} total=${audit.total}`);
    markQualityMetric('audits', 1);
    
    if (audit.pass !== false) break; // 通过则直接返回
    markQualityMetric('failedAudits', 1);

    // 不通过：带着 Check Agent 的反馈让子 Agent 重写
    console.log(`[check_agent] rewriting: ${audit.feedback}`);
    response = await generateFn(audit.feedback);
    rewriteCount += 1;
    markQualityMetric('rewrites', 1);
  }

  try {
    await recordAgentQualityAudit({
      route,
      username: '',
      queryText: userQuery,
      responseText: response,
      auditResult: lastAudit || {},
      passed: lastAudit?.pass !== false,
      rewriteCount
    });
  } catch (e) {}

  return response;
}

async function enforceUnifiedQualityGate({
  userQuery,
  route,
  response,
  agentData,
  senderUsername,
  senderRole,
  store,
  brand
}) {
  const checkEnabledRoutes = ['chief_evaluator', 'data_auditor', 'ops_supervisor', 'appeal', 'train_advisor'];
  if (!checkEnabledRoutes.includes(route)) return { response, agentData };
  if (agentData?.deterministic === true) {
    return { response, agentData: { ...(agentData || {}), qualityAudit: { pass: true, total: 0, rewriteCount: 0, skipped: 'deterministic' } } };
  }

  let nextResponse = String(response || '');
  const nextAgentData = { ...(agentData || {}) };
  const evidence = buildEvidencePackage(nextAgentData, { route, store, brand });
  const evidenceText = JSON.stringify(evidence);

  let audit = await checkAgentAudit(userQuery, nextResponse, route, { evidenceText, role: senderRole });
  let rewriteCount = 0;
  markQualityMetric('audits', 1);

  if (audit.pass === false) {
    markQualityMetric('failedAudits', 1);
    nextResponse = await rewriteResponseByAudit({
      userQuery,
      response: nextResponse,
      route,
      feedback: audit.feedback,
      evidenceText,
      role: senderRole
    });
    rewriteCount += 1;
    markQualityMetric('rewrites', 1);
    audit = await checkAgentAudit(userQuery, nextResponse, route, { evidenceText, role: senderRole });
    markQualityMetric('audits', 1);
  }

  if (route === 'data_auditor' && detectFactDemand(userQuery) === 'hard') {
    const numericCheck = verifyNumericGrounding(nextResponse, evidenceText + '\n' + String(nextAgentData?.groundingFacts || ''));
    if (!numericCheck.ok) {
      markQualityMetric('numericViolations', 1);
      nextResponse = `当前问题需要精确数字支撑，我暂时无法在现有证据中完成可靠计算。建议先补齐数据后重试。`;
      nextAgentData.numericGroundingBlocked = true;
      nextAgentData.numericMissing = numericCheck.missing;
      audit = { ...(audit || {}), pass: false, feedback: 'numeric_grounding_failed' };
    }
  }

  await recordAgentQualityAudit({
    route,
    username: senderUsername,
    queryText: userQuery,
    responseText: nextResponse,
    auditResult: { ...(audit || {}), evidence },
    passed: audit?.pass !== false,
    rewriteCount
  });

  nextAgentData.qualityAudit = {
    pass: audit?.pass !== false,
    total: Number(audit?.total || 0),
    rewriteCount
  };
  return { response: nextResponse, agentData: nextAgentData };
}

let _bitablePollingInterval = null;
let _bitablePollingInProgress = false;

export function startBitablePolling(intervalMs = 60000) {
  if (_bitablePollingInterval) {
    clearInterval(_bitablePollingInterval);
  }
  
  console.log('[bitable] starting multi-config polling with interval:', intervalMs, 'ms');
  
  const runPollingOnce = async () => {
    if (_bitablePollingInProgress) {
      console.log('[bitable] previous polling cycle still running, skip this tick');
      return;
    }
    _bitablePollingInProgress = true;
    try {
      await pollAllBitableSubmissions();
    } catch (e) {
      console.error('[bitable] pollAllBitableSubmissions error:', e?.message || e);
    } finally {
      _bitablePollingInProgress = false;
    }
  };

  // 立即执行一次
  runPollingOnce().catch(console.error);
  
  // 设置定时器
  _bitablePollingInterval = setInterval(() => {
    runPollingOnce().catch(console.error);
  }, intervalMs);
  
  // 启动归档定时任务（每天检查一次）
  startArchiveScheduler();
}

export function startArchiveScheduler() {
  // 每天凌晨 3 点执行归档
  const scheduleNextArchive = () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(3, 0, 0, 0);
    
    const msUntilArchive = tomorrow.getTime() - now.getTime();
    
    setTimeout(async () => {
      console.log('[bitable] running daily archive task');
      const result = await archiveOldBitableSubmissions();
      console.log('[bitable] archive result:', result);
      
      // 检查容量告警
      await checkBitableCapacity();
      
      // 递归调度下一次
      scheduleNextArchive();
    }, msUntilArchive);
    
    console.log('[bitable] next archive scheduled for:', tomorrow.toISOString());
  };
  
  scheduleNextArchive();
}

export async function checkBitableCapacity() {
  try {
    const stats = await getBitableSubmissionStats();
    const mainCount = stats.main.total || 0;
    const totalCount = stats.total || 0;
    
    console.log(`[bitable] capacity check: main=${mainCount}, total=${totalCount}`);
    
    // 容量告警（调整阈值）
    if (mainCount > 1000) {
      const warning = `⚠️ Bitable 容量提醒\n主表记录数：${mainCount}/2000\n总记录数：${totalCount}\n系统已启用自动归档，7天后数据移至归档表，60天后自动删除`;
      console.warn('[bitable] CAPACITY WARNING:', warning);
      // await sendLarkMessage(adminOpenId, prefixWithAgentName('system', warning));
    }
    
    if (mainCount > 1500) {
      const critical = `🚨 Bitable 容量预警\n主表记录数：${mainCount}/2000\n系统将自动清理旧数据，无需手动干预`;
      console.error('[bitable] CAPACITY CRITICAL:', critical);
      // await sendLarkMessage(adminOpenId, prefixWithAgentName('system', critical));
    }
    
  } catch (e) {
    console.error('[bitable] capacity check failed:', e?.message);
  }
}

export function stopBitablePolling() {
  if (_bitablePollingInterval) {
    clearInterval(_bitablePollingInterval);
    _bitablePollingInterval = null;
    console.log('[bitable] polling stopped');
  }
}

// ─────────────────────────────────────────────
// 13. Feishu Webhook Event Handler
// ─────────────────────────────────────────────

// Dedup: track processed event IDs (in-memory, last 500)
const _processedEvents = new Set();
const _processedEventsQueue = [];
function markEventProcessed(eventId) {
  if (_processedEvents.size > 500) {
    const old = _processedEventsQueue.shift();
    _processedEvents.delete(old);
  }
  _processedEvents.add(eventId);
  _processedEventsQueue.push(eventId);
}

async function tryCaptureOpsChecklistDetailFromChat(openId, feishuUser, text, imageUrls) {
  const storeName = String(feishuUser?.store || '').trim();
  if (!openId || !storeName) return { handled: false };

  const candidates = [];
  const today = new Date().toISOString().slice(0, 10);
  candidates.push(`${openId}||${storeName}||opening||${today}`);
  candidates.push(`${openId}||${storeName}||closing||${today}`);

  let matchedKey = '';
  let progress = null;
  for (const key of candidates) {
    const p = _opsChecklistProgress.get(key);
    if (p && Number.isFinite(p.pendingItemIndex) && p.pendingItemIndex >= 0) {
      matchedKey = key;
      progress = p;
      break;
    }
  }
  if (!progress) return { handled: false };

  const idx = progress.pendingItemIndex;
  const itemName = String(progress.pendingItemName || '').trim() || `第${idx + 1}项`;
  if (!progress.itemDetails[idx]) progress.itemDetails[idx] = { status: '', remark: '', photoCount: 0 };

  let changed = false;
  if (text) {
    const normalized = text.replace(/^说明[：:]/, '').trim();
    if (normalized) {
      progress.itemDetails[idx].remark = normalized;
      changed = true;
    }
  }
  if (Array.isArray(imageUrls) && imageUrls.length) {
    progress.itemDetails[idx].photoCount = (Number(progress.itemDetails[idx].photoCount) || 0) + imageUrls.length;
    changed = true;
  }

  if (!changed) return { handled: false };

  const abnormalCount = countOpsChecklistAbnormal(progress);
  const detail = progress.itemDetails[idx] || {};
  const statusText = detail.status === 'pass' ? '合格' : detail.status === 'fail' ? '异常' : '未标记';
  const remarkText = String(detail.remark || '').trim() ? '已填写' : '未填写';
  const photoText = `${Number(detail.photoCount) || 0}张`;

  await sendLarkMessage(
    openId,
    prefixWithAgentName('ops_supervisor', `已更新【${itemName}】\n状态：${statusText}\n说明：${remarkText}\n照片：${photoText}\n\n当前已记录异常：${abnormalCount}项`)
  );

  return { handled: true, progressKey: matchedKey, abnormalCount };
}

export async function onFeishuEvent(body) {
  // URL verification challenge
  if (body?.type === 'url_verification' || body?.challenge) {
    console.log('[feishu] URL verification challenge received');
    return { challenge: body.challenge };
  }

  const header = body?.header || {};
  const event = body?.event || {};
  const eventId = String(header?.event_id || '').trim();
  const eventType = String(header?.event_type || '').trim();

  // Dedup
  if (eventId && _processedEvents.has(eventId)) {
    return { ok: true, dedup: true };
  }
  if (eventId) markEventProcessed(eventId);

  console.log('[feishu] event:', eventType, 'id:', eventId, 'build:v176');

  if (eventType === 'card.action.trigger') {
    return await handleOpsChecklistCardAction(event);
  }

  if (eventType === 'im.message.receive_v1') {
    const msg = event?.message || {};
    const sender = event?.sender || {};
    const msgType = String(msg?.message_type || '').trim();
    const messageId = String(msg?.message_id || '').trim();
    const parentMessageId = String(msg?.parent_id || msg?.parent_message_id || '').trim();
    const rootMessageId = String(msg?.root_id || msg?.root_message_id || '').trim();
    const chatType = String(msg?.chat_type || '').trim();
    const openId = String(sender?.sender_id?.open_id || '').trim();

    if (!openId) return { ok: true, skipped: 'no_sender' };
    // Only handle private (single chat) messages - accept both 'private' and 'p2p'
    if (chatType !== 'private' && chatType !== 'p2p') {
      console.log('[feishu] skipping non-private message, chat_type:', chatType);
      return { ok: true, skipped: 'not_private' };
    }

    // ── Check user registration ──
    let feishuUser = await lookupFeishuUser(openId);

    if (!feishuUser || !feishuUser.registered) {
      // Parse text
      let inputText = '';
      if (msgType === 'text') {
        try { inputText = String(JSON.parse(msg?.content || '{}').text || '').trim(); } catch (e) { inputText = String(msg?.content || '').trim(); }
      }

      if (inputText) {
        // Try to register with the text as username
        const regResult = await registerFeishuUser(openId, inputText);
        if (regResult.ok) {
          const u = regResult.user;
          await sendLarkMessage(openId,
            `✅ 绑定成功！${u.name || u.username}（${u.store || ''}），你好！\n\n我是HRMS智能助理，可以帮你：\n📊 查数据 — "昨天损耗多少？""差评情况？"\n📷 审图片 — 直接发照片，我帮你审核卫生/出品\n📈 看绩效 — "我这周考核分多少？"\n📖 问SOP — "外卖漏发餐具怎么赔付？"\n✋ 申诉 — "申诉昨天损耗扣分，原因是停电"\n\n现在就可以开始对话了！`
          );
          return { ok: true, registered: true, username: u.username };
        }
      }

      // Save unregistered user record
      try {
        await pool().query(
          `INSERT INTO feishu_users (open_id, registered) VALUES ($1, FALSE) ON CONFLICT (open_id) DO NOTHING`, [openId]
        );
      } catch (e) {}

      await sendLarkMessage(openId,
        `你好！我是HRMS智能助理 🤖\n\n首次使用需要绑定HRMS账号。\n请输入你的HRMS用户名（登录HRMS系统时使用的用户名）：`
      );
      return { ok: true, pendingRegistration: true };
    }

    // ── User is registered, process message ──
    let text = '';
    let imageUrls = [];

    if (msgType === 'text') {
      try { text = String(JSON.parse(msg?.content || '{}').text || '').trim(); } catch (e) { text = String(msg?.content || '').trim(); }
      // Remove @bot mention text
      if (msg?.mentions?.length) {
        for (const m of msg.mentions) {
          text = text.replace(new RegExp(`@${m.name || ''}`, 'g'), '').trim();
        }
      }
    } else if (msgType === 'image') {
      try {
        const content = JSON.parse(msg?.content || '{}');
        const imageKey = content?.image_key || '';
        if (imageKey && messageId) {
          console.log('[feishu] downloading image:', imageKey);
          const imgUrl = await getLarkImageUrl(messageId, imageKey);
          if (imgUrl) imageUrls.push(imgUrl);
        }
      } catch (e) { console.error('[feishu] parse image failed:', e?.message); }
    } else if (msgType === 'audio') {
      // 语音消息 → 飞书ASR识别 → 转为文字处理 (零LLM算力)
      try {
        const content = JSON.parse(msg?.content || '{}');
        const fileKey = content?.file_key || '';
        if (fileKey && messageId) {
          const recognized = await recognizeLarkAudio(messageId, fileKey);
          if (recognized) {
            text = recognized;
            console.log(`[feishu] voice → text: "${text.slice(0, 60)}"`);
          } else {
            await sendLarkMessage(openId, '🎙️ 语音识别未成功，请再试一次或用文字描述。', { skipDedup: true });
            return { ok: true, skipped: 'asr_empty' };
          }
        } else {
          await sendLarkMessage(openId, '🎙️ 语音消息格式异常，请用文字描述你的问题。', { skipDedup: true });
          return { ok: true, skipped: 'audio_no_filekey' };
        }
      } catch (e) {
        console.error('[feishu] audio parse failed:', e?.message);
        await sendLarkMessage(openId, '🎙️ 语音识别服务暂时不可用，请用文字描述。', { skipDedup: true });
        return { ok: true, skipped: 'asr_error' };
      }
    } else {
      await sendLarkMessage(openId, `收到${msgType}消息。目前支持文字和图片，请用文字描述或发送照片。`);
      return { ok: true, skipped: 'unsupported_type' };
    }

    if (!text && !imageUrls.length) return { ok: true, skipped: 'empty' };

    const detailCapture = await tryCaptureOpsChecklistDetailFromChat(openId, feishuUser, text, imageUrls);
    if (detailCapture?.handled) {
      return { ok: true, route: 'ops_supervisor', checklistDetailCaptured: true };
    }

    const checklistType = detectOpsChecklistType(text);
    if (msgType === 'text' && checklistType) {
      const sharedState = await getSharedState();
      const brandContext = resolveBrandContextByStore(sharedState, feishuUser.store || '');
      const storeName = String(feishuUser.store || '').trim();
      const typeLabel = checklistType === 'opening' ? '开市' : '收档';
      
      // 发送 Bitable 表单卡片（含按钮）
      const formUrl = 'https://ycnp8e71t8x8.feishu.cn/base/PtVObRtoPaMAP3stIIFc8DnJngd?table=tblxHI9ZAKONOTpp&view=vewjuqywQu';
      const headerColor = checklistType === 'closing' ? 'orange' : 'blue';
      const timeNow = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      
      const checkCard = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: `📋 ${typeLabel}检查通知` }, template: headerColor },
        elements: [
          {
            tag: 'div',
            fields: [
              { is_short: true, text: { tag: 'lark_md', content: `**门店**\n${storeName || '-'}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**检查类型**\n${typeLabel}检查` } },
              { is_short: true, text: { tag: 'lark_md', content: `**时间**\n${timeNow}` } }
            ]
          },
          { tag: 'hr' },
          {
            tag: 'div',
            text: { tag: 'lark_md', content: '请点击下方按钮打开检查表，逐项检查并提交：' }
          },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '📝 打开检查表' },
                type: 'primary',
                url: formUrl
              }
            ]
          },
          { tag: 'hr' },
          {
            tag: 'note',
            elements: [
              { tag: 'plain_text', content: '填写完成后系统自动确认 · 小年' }
            ]
          }
        ]
      };
      
      const cardResult = await sendLarkCard(openId, checkCard);
      if (!cardResult.ok) {
        // 降级到文本消息
        await sendLarkMessage(openId, prefixWithAgentName('ops_supervisor', `📋 请填写${typeLabel}检查表\n\n🔗 ${formUrl}\n\n✅ 填写完成后系统会自动确认`));
      }

      try {
        await pool().query(
          `INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, sender_role, routed_to, content_type, content, agent_data)
           VALUES ('out','feishu',$1,$2,$3,$4,'ops_supervisor','bitable_form',$5,$6::jsonb)`,
          [openId, feishuUser.username, feishuUser.name || feishuUser.username, feishuUser.role || '', `${typeLabel}检查表（Bitable表单）`, JSON.stringify({ checklistType, via: 'bitable_form', formUrl })]
        );
      } catch (e) {}

      return { ok: true, route: 'ops_supervisor', bitableForm: true };
    }

    // Log incoming message
    let msgDbId = null;
    try {
      const r = await pool().query(
        `INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, sender_role, content_type, content, image_urls, feishu_message_id)
         VALUES ('in','feishu',$1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id`,
        [openId, feishuUser.username, feishuUser.name, feishuUser.role,
         imageUrls.length ? 'image' : 'text', text || '',
         JSON.stringify(imageUrls), messageId]
      );
      msgDbId = r.rows?.[0]?.id;
    } catch (e) {}

    // ── Master Agent: 任务反馈拦截 ──
    console.log('[feishu] task-reply-debug: parentMessageId=', JSON.stringify(parentMessageId), 'rootMessageId=', JSON.stringify(rootMessageId), 'text=', JSON.stringify(String(text||'').slice(0,60)), 'msgKeys=', JSON.stringify(Object.keys(msg)));
    // 以下情况视为任务回复：1)回复了任务消息(parentMessageId/rootMessageId非空) 2)含图片(拍照证据) 3)明确提及任务编号 4)明确回复类关键词
    const _effectiveParentId = parentMessageId || rootMessageId || '';
    const _isLikelyTaskResponse = !!_effectiveParentId ||
      (imageUrls.length > 0) ||
      /^(TASK|OPS|BI|EVAL|MT)-/i.test(String(text || '').trim()) ||
      /(已处理|已完成|已整改|已解决|处理完|整改完毕|情况说明|原因如下|回复你|测试)/.test(String(text || '').trim());
    if (_taskResponseHook && _isLikelyTaskResponse) {
      try {
        const taskResult = await _taskResponseHook(feishuUser.username, text, imageUrls, _effectiveParentId);
        if (taskResult?.handled) {
          const reply = prefixWithAgentName('master', taskResult.response);
          await sendLarkMessage(openId, reply);
          try {
            if (msgDbId) {
              await pool().query(
                `UPDATE agent_messages SET routed_to='master', agent_response=$1, agent_data=$2::jsonb WHERE id=$3`,
                [taskResult.response, JSON.stringify({ taskId: taskResult.taskId, route: 'master_task' }), msgDbId]
              );
            }
          } catch (e) {}
          return { ok: true, route: 'master', taskId: taskResult.taskId };
        }
      } catch (e) {
        console.error('[feishu] task response hook error:', e?.message);
      }
    }

    // Route and handle
    const sharedState = await getSharedState();
    const brandContext = resolveBrandContextByStore(sharedState, feishuUser.store || '');

    // 预路由权限检查
    const hasImg = Array.isArray(imageUrls) && imageUrls.length > 0;
    const preRoute = await routeMessage(text, hasImg, feishuUser.username);
    const userRole = String(feishuUser.role || '').trim();
    if (preRoute?.route && userRole) {
      const permCheck = checkAgentPermission(userRole, preRoute.route);
      if (!permCheck.allowed) {
        await sendLarkMessage(openId, `⚠️ ${permCheck.reason}`);
        return { ok: true, denied: true, route: preRoute.route, role: userRole };
      }
    }

    // ── 耗时请求: 先回复 "正在查询..." 再处理 ──
    const _t = String(text || '').trim();
    const _isSlowRequest = _t.includes('行动计划') || _t.includes('健康度') || _t.includes('改善方案')
      || _t.includes('因果') || _t.includes('对比') || _t.includes('预估')
      || _t.includes('营业额') || _t.includes('毛利') || _t.includes('损耗')
      || _t.includes('差评') || _t.includes('绩效') || _t.includes('考核')
      || (imageUrls.length > 0);
    if (_isSlowRequest) {
      const loadingHint = imageUrls.length > 0 ? '📸 收到照片，正在审核中...' : '🔍 正在为您查询，请稍候...';
      sendLarkMessage(openId, loadingHint, { skipDedup: true }).catch(() => {});
    }

    const rawResult = await handleAgentMessage(
      feishuUser.username, feishuUser.name || feishuUser.username,
      feishuUser.store || '', feishuUser.role || '', brandContext,
      text, imageUrls
    );
    const result = (rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult))
      ? rawResult
      : { route: 'general', response: String(rawResult || ''), agentData: {} };

    // Reply via Feishu — 直接发送文本消息 (卡片在部分飞书版本不显示，统一用文本保证送达)
    if (result.response) {
      await sendLarkMessage(openId, prefixWithAgentName(result.route, result.response), { skipDedup: true });
    }

    // Log response
    try {
      if (msgDbId) {
        await pool().query(
          `UPDATE agent_messages SET routed_to=$1, agent_response=$2, agent_data=$3::jsonb WHERE id=$4`,
          [result.route, result.response, JSON.stringify(result.agentData || {}), msgDbId]
        );
      }
    } catch (e) {}

    return { ok: true, route: result.route, responded: !!result.response };
  }

  return { ok: true, unhandled: eventType };
}

// ─────────────────────────────────────────────
// 12. Feishu Push Notifications
// ─────────────────────────────────────────────

// Push new issues to their assignees via Feishu
async function pushIssuesToFeishu() {
  try {
    const r = await pool().query(
      `SELECT ai.id, ai.title, ai.detail, ai.severity, ai.store, ai.category, ai.assignee_username
       FROM agent_issues ai
       WHERE ai.feishu_notified = FALSE AND ai.assignee_username IS NOT NULL
       ORDER BY ai.created_at DESC LIMIT 20`
    );
    if (!r.rows?.length) return 0;

    let pushed = 0;
    for (const issue of r.rows) {
      const fu = await lookupFeishuUserByUsername(issue.assignee_username);
      if (!fu?.open_id) continue;

      const sev = issue.severity === 'high' ? '🔴 高优先级' : '🟡 中优先级';
      const sevTemplate = issue.severity === 'high' ? 'red' : 'orange';
      const anomalyCard = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: `${sev} 异常通知` }, template: sevTemplate },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: `**门店**：${issue.store || '-'}\n**类别**：${issue.category || '-'}` } },
          { tag: 'hr' },
          { tag: 'div', text: { tag: 'lark_md', content: `📋 **${issue.title}**\n\n${issue.detail || ''}` } },
          { tag: 'hr' },
          { tag: 'div', text: { tag: 'lark_md', content: `⏰ 请在 **1小时内** 查看并回复整改措施。\n直接回复文字说明整改情况，或发送整改照片。` } },
          { tag: 'note', elements: [{ tag: 'plain_text', content: `小年 · 异常检测` }] }
        ]
      };

      let sendResult = await sendLarkCard(fu.open_id, anomalyCard);
      if (!sendResult.ok) {
        const msg = prefixWithAgentName('data_auditor', `${sev} 异常通知\n\n📋 ${issue.title}\n\n${issue.detail || ''}\n\n⏰ 请在1小时内查看并回复整改措施。`);
        sendResult = await sendLarkMessage(fu.open_id, msg);
      }
      if (sendResult.ok) {
        await pool().query(`UPDATE agent_issues SET feishu_notified = TRUE WHERE id = $1`, [issue.id]);
        pushed++;

        // Log outbound message
        try {
          await pool().query(
            `INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, routed_to, content_type, content)
             VALUES ('out','feishu',$1,$2,$3,'data_auditor','text',$4)`,
            [fu.open_id, 'system', 'HRMS Agent', `${sev} 异常通知: ${issue.title}`]
          );
        } catch (e) {}
      }
    }
    return pushed;
  } catch (e) {
    console.error('[feishu] push issues failed:', e?.message);
    return 0;
  }
}

// Push performance scores to users via Feishu
async function pushScoresToFeishu() {
  try {
    const r = await pool().query(
      `SELECT * FROM agent_scores WHERE feishu_notified = FALSE ORDER BY created_at DESC LIMIT 20`
    );
    if (!r.rows?.length) return 0;

    let pushed = 0;
    for (const score of r.rows) {
      const fu = await lookupFeishuUserByUsername(score.username);
      if (!fu?.open_id) continue;

      const deductions = Array.isArray(score.deductions) ? score.deductions : [];
      const deductionText = deductions.length
        ? deductions.map(d => `  • ${d.category}: ${d.points}分`).join('\n')
        : '  无扣分项';

      const msgText = `📊 绩效考核通知\n\n${fu.name || score.username}，你在${score.store}（${score.brand}）的${score.period}考核结果：\n\n📊 总分：${score.total_score} 分\n📋 模型：${score.score_model}\n${Object.entries(score.breakdown || {}).map(([k, v]) => `  • ${k}: ${v}分`).join('\n')}\n\n扣分明细：\n${deductionText}\n\n${score.summary || ''}\n\n如有异议，请回复"申诉"并说明原因。`;
      const msg = prefixWithAgentName('chief_evaluator', msgText);

      const sendResult = await sendLarkMessage(fu.open_id, msg);
      if (sendResult.ok) {
        await pool().query(`UPDATE agent_scores SET feishu_notified = TRUE WHERE id = $1`, [score.id]);
        pushed++;
      }
    }
    return pushed;
  } catch (e) {
    console.error('[feishu] push scores failed:', e?.message);
    return 0;
  }
}

// ─────────────────────────────────────────────
// 13. Scheduler
// ─────────────────────────────────────────────

let _schedulerStarted = false;

// ── 防护措施：启动断言 + LLM健康检查 + 连续错误告警 ──
const _errorTracker = { consecutiveLLMErrors: 0, lastAlertTime: 0, alertCooldownMs: 10 * 60 * 1000 };
const _llmHealthState = { lastAllOk: null, lastSummary: '' };

export async function verifyLLMHealth(options = {}) {
  const notifyOnFailure = options.notifyOnFailure !== false;
  const notifyOnRecovery = options.notifyOnRecovery !== false;
  const forceNotify = !!options.forceNotify;
  const results = [];
  const providers = [
    { name: 'DeepSeek', model: DEEPSEEK_MODEL, apiKey: DEEPSEEK_API_KEY, baseUrl: DEEPSEEK_BASE_URL },
    { name: 'Qwen', model: QWEN_MODEL, apiKey: QWEN_API_KEY, baseUrl: QWEN_BASE_URL },
    { name: 'Doubao(Vision)', model: DEEPSEEK_VISION_MODEL, apiKey: DOUBAO_API_KEY, baseUrl: DOUBAO_BASE_URL }
  ];
  const providerKeyMap = { DeepSeek: 'deepseek', Qwen: 'qwen', 'Doubao(Vision)': 'doubao' };
  for (const p of providers) {
    if (!p.apiKey) { results.push({ name: p.name, ok: false, error: 'API_KEY未配置' }); continue; }
    try {
      const resp = await axios.post(`${p.baseUrl}/chat/completions`, {
        model: p.model, messages: [{ role: 'user', content: '回复OK' }], max_tokens: 5, temperature: 0
      }, { headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 });
      const content = resp.data?.choices?.[0]?.message?.content || '';
      results.push({ name: p.name, model: p.model, ok: true, reply: content.slice(0, 20) });
      markProviderOk(providerKeyMap[p.name] || '');
    } catch (e) {
      const status = e?.response?.status || 'timeout';
      const msg = e?.response?.data?.error?.message || e?.message || '未知错误';
      results.push({ name: p.name, model: p.model, ok: false, error: `HTTP ${status}: ${msg.slice(0, 100)}` });
      markProviderFail(providerKeyMap[p.name] || '');
      markProviderFail(providerKeyMap[p.name] || '');
    }
  }
  const allOk = results.every(r => r.ok);
  const summary = results.map(r => `${r.ok ? '✅' : '❌'} ${r.name}(${r.model || '?'}): ${r.ok ? r.reply : r.error}`).join('\n');
  const prevAllOk = _llmHealthState.lastAllOk;
  _llmHealthState.lastAllOk = allOk;
  _llmHealthState.lastSummary = summary;
  console.log(`[LLM-HEALTH] Startup check:\n${summary}`);
  const healthyProviders = results.filter(r => r.ok).map(r => r.name);
  const downProviders = results.filter(r => !r.ok).map(r => r.name);
  if (!allOk && notifyOnFailure && (forceNotify || prevAllOk !== false)) {
    const fallbackNote = healthyProviders.length > 0
      ? `\n\n🔄 自动降级已激活：${downProviders.join('、')} 不可用时，Agent 将自动切换到 ${healthyProviders.join('、')} 继续工作。`
      : '\n\n⚠️ 所有 Provider 均不可用，Agent 将完全无法响应！';
    console.error('[LLM-HEALTH] ⚠️ 部分LLM不可用，自动降级已激活');
    try {
      await sendErrorAlertToAdmin(`⚠️ 【系统告警】LLM健康检查未通过:\n${summary}${fallbackNote}\n\n请检查 API Key / 模型配置 / 网络连通性。`);
    } catch (_) {}
  }
  if (allOk && notifyOnRecovery && prevAllOk === false) {
    try {
      await sendErrorAlertToAdmin(`✅ 【系统恢复】LLM健康检查已恢复正常:\n${summary}`);
    } catch (_) {}
  }
  return { allOk, results };
}

export function assertCriticalFunctions() {
  const critical = [
    ['resolveModelProvider', typeof resolveModelProvider],
    ['getLLMClientConfig', typeof getLLMClientConfig],
    ['checkAgentPermission', typeof checkAgentPermission],
    ['callLLM', typeof callLLM],
    ['callVisionLLM', typeof callVisionLLM],
    ['routeMessage', typeof routeMessage],
    ['handleAgentMessage', typeof handleAgentMessage],
    ['sendLarkMessage', typeof sendLarkMessage],
    ['buildFeishuCardFromAgentReply', typeof buildFeishuCardFromAgentReply],
    ['resolveDateRangeFromQuestion', typeof resolveDateRangeFromQuestion],
    ['formatDate', typeof formatDate],
    ['isDataBackedReply', typeof isDataBackedReply],
    ['buildKpiRadarAlertJson', typeof buildKpiRadarAlertJson],
    ['buildBiDeterministicTableVisitReply', typeof buildBiDeterministicTableVisitReply],
  ];
  const missing = critical.filter(([, t]) => t !== 'function');
  if (missing.length > 0) {
    const msg = `[CRITICAL] Missing functions at startup: ${missing.map(([n]) => n).join(', ')}`;
    console.error(msg);
    throw new Error(msg);
  }
  console.log('[agents] Startup assertion passed: all critical functions defined');
}

async function sendErrorAlertToAdmin(errorMsg) {
  const now = Date.now();
  if (now - _errorTracker.lastAlertTime < _errorTracker.alertCooldownMs) return;
  _errorTracker.lastAlertTime = now;
  try {
    const state = await getSharedState();
    const allUsers = [
      ...(Array.isArray(state?.employees) ? state.employees : []),
      ...(Array.isArray(state?.users) ? state.users : [])
    ];
    const recipients = allUsers.filter(u => ['admin', 'hq_manager'].includes(String(u?.role || '').trim()));
    for (const admin of recipients) {
      const fu = await lookupFeishuUserByUsername(String(admin.username || '').trim());
      if (fu?.open_id) {
        await sendLarkMessage(
          fu.open_id,
          `🚨 系统告警\n\n${errorMsg}\n\n时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n请尽快检查服务状态。`,
          { skipDedup: true }
        );
      }
    }
  } catch (e) {
    console.error('[alert] Failed to send admin alert:', e?.message);
  }
}

export function trackLLMResult(ok) {
  if (ok) {
    _errorTracker.consecutiveLLMErrors = 0;
  } else {
    _errorTracker.consecutiveLLMErrors++;
    if (_errorTracker.consecutiveLLMErrors >= 5) {
      sendErrorAlertToAdmin(`LLM 连续调用失败 ${_errorTracker.consecutiveLLMErrors} 次，Agent 可能无法正常回复。请检查 API Key 和网络。`);
    }
  }
}

export function getAgentHealthStatus() {
  return {
    schedulerRunning: _schedulerStarted,
    consecutiveLLMErrors: _errorTracker.consecutiveLLMErrors,
    performanceMetrics: { ..._performanceMetrics },
    llmHealthy: _errorTracker.consecutiveLLMErrors < 5
  };
}

export function startAgentScheduler() {
  if (_schedulerStarted) return;
  _schedulerStarted = true;

  // 启动后做一次延迟健康检查 + 周期检查（防止DeepSeek挂了无告警）
  setTimeout(() => {
    verifyLLMHealth({ notifyOnFailure: true, notifyOnRecovery: true }).catch((e) => {
      console.error('[LLM-HEALTH] periodic check error:', e?.message);
    });
  }, 30000);
  setInterval(() => {
    verifyLLMHealth({ notifyOnFailure: true, notifyOnRecovery: true }).catch((e) => {
      console.error('[LLM-HEALTH] periodic check error:', e?.message);
    });
  }, 10 * 60 * 1000);

  // Data audit + push issues every 30 minutes
  const auditTick = async () => {
    try {
      const result = await runDataAuditor();
      if (result.issuesCreated > 0) {
        console.log(`[scheduler] Data Auditor: ${result.issuesCreated} new issues`);
      }
      // Push new issues to Feishu
      const pushed = await pushIssuesToFeishu();
      if (pushed > 0) console.log(`[scheduler] Pushed ${pushed} issues to Feishu`);
    } catch (e) {
      console.error('[scheduler] audit tick error:', e?.message);
    }
  };

  // Weekly evaluation (Monday 9am) + push scores
  const evalTick = async () => {
    try {
      const now = new Date();
      if (now.getDay() === 1 && now.getHours() === 9) {
        const weekNum = Math.ceil((now.getDate() + new Date(now.getFullYear(), now.getMonth(), 1).getDay()) / 7);
        const period = `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
        const result = await runChiefEvaluator(period);
        console.log(`[scheduler] Chief Evaluator: ${result.evaluated} staff for ${period}`);

        // Push scores to Feishu
        const pushed = await pushScoresToFeishu();
        if (pushed > 0) console.log(`[scheduler] Pushed ${pushed} scores to Feishu`);
      }
    } catch (e) {
      console.error('[scheduler] eval tick error:', e?.message);
    }
  };

  // OP Agent: 每周一早上10点督办周异常（实收营收、人效值、桌访产品、桌访占比、产品/服务差评）
  const weeklyOpsTick = async () => {
    try {
      const now = new Date();
      // 周一且10点执行
      if (now.getDay() === 1 && now.getHours() === 10 && now.getMinutes() < 5) {
        console.log('[scheduler] OP Agent: 开始督办周异常...');
        
        // 查询过去7天的周异常（未解决的）
        const weeklyCategories = [
          '实收营收异常',
          '人效值异常', 
          '桌访产品异常',
          '桌访占比异常',
          '产品差评异常',
          '服务差评异常'
        ];
        
        const result = await pool().query(
          `SELECT * FROM agent_issues 
           WHERE category = ANY($1) 
             AND status != 'resolved'
             AND created_at >= NOW() - INTERVAL '7 days'
           ORDER BY store, category`,
          [weeklyCategories]
        );
        
        if (result.rows?.length > 0) {
          console.log(`[scheduler] OP Agent: 发现 ${result.rows.length} 条周异常待督办`);
          
          // 按门店分组并发送督办通知
          const byStore = {};
          for (const issue of result.rows) {
            if (!byStore[issue.store]) byStore[issue.store] = [];
            byStore[issue.store].push(issue);
          }
          
          for (const [store, issues] of Object.entries(byStore)) {
            const issueList = issues.map(i => `• ${i.category}(${i.severity}): ${i.title}`).join('\n');
            const message = `【OP周督办 - ${store}】\n\n门店本周有以下异常需整改：\n\n${issueList}\n\n请在今日内提交整改方案。`;
            
            // 发送给店长/出品经理
            for (const issue of issues) {
              try {
                await pushIssueToAssignee(issue, message);
              } catch (e) {
                console.error(`[scheduler] OP周督办推送失败: ${issue.assignee_username}`, e?.message);
              }
            }
          }
        } else {
          console.log('[scheduler] OP Agent: 本周无周异常需督办');
        }
      }
    } catch (e) {
      console.error('[scheduler] OP周督办 tick error:', e?.message);
    }
  };

  // OP Agent: 每天早上10点督办充值异常
  const dailyRechargeTick = async () => {
    try {
      const now = new Date();
      // 每天10点执行（分钟数<5避免重复执行）
      if (now.getHours() === 10 && now.getMinutes() < 5) {
        console.log('[scheduler] OP Agent: 开始督办充值异常...');
        
        // 查询过去24小时的充值异常（未解决的）
        const result = await pool().query(
          `SELECT * FROM agent_issues 
           WHERE category = '充值异常'
             AND status != 'resolved'
             AND created_at >= NOW() - INTERVAL '24 hours'
           ORDER BY store`
        );
        
        if (result.rows?.length > 0) {
          console.log(`[scheduler] OP Agent: 发现 ${result.rows.length} 条充值异常待督办`);
          
          // 按门店分组
          const byStore = {};
          for (const issue of result.rows) {
            if (!byStore[issue.store]) byStore[issue.store] = [];
            byStore[issue.store].push(issue);
          }
          
          for (const [store, issues] of Object.entries(byStore)) {
            const highCount = issues.filter(i => i.severity === 'high').length;
            const mediumCount = issues.filter(i => i.severity === 'medium').length;
            const message = `【OP日督办 - ${store}】\n\n门店今日充值异常：\n• 高风险: ${highCount} 条\n• 中风险: ${mediumCount} 条\n\n请立即检查充值系统并提交整改方案。`;
            
            // 发送给店长
            for (const issue of issues) {
              try {
                await pushIssueToAssignee(issue, message);
              } catch (e) {
                console.error(`[scheduler] OP日督办推送失败: ${issue.assignee_username}`, e?.message);
              }
            }
          }
        } else {
          console.log('[scheduler] OP Agent: 今日无充值异常需督办');
        }
      }
    } catch (e) {
      console.error('[scheduler] OP日督办 tick error:', e?.message);
    }
  };

  // Retry pushing un-notified items every 5 minutes
  const pushTick = async () => {
    try {
      const pushedIssues = await pushIssuesToFeishu();
      const pushedScores = await pushScoresToFeishu();
      if (pushedIssues || pushedScores) {
        console.log(`[scheduler] Push retry: ${pushedIssues} issues, ${pushedScores} scores`);
      }
    } catch (e) {}
  };

  // Initial run after 15 seconds
  setTimeout(auditTick, 15000);

  // Periodic runs
  setInterval(auditTick, 30 * 60 * 1000);   // every 30 min
  setInterval(evalTick, 60 * 60 * 1000);     // every hour
  setInterval(weeklyOpsTick, 60 * 60 * 1000); // every hour (checks if Monday 10am)
  setInterval(dailyRechargeTick, 60 * 60 * 1000); // every hour (checks if 10am)
  setInterval(pushTick, 5 * 60 * 1000);      // every 5 min

  console.log('[agents] Feishu-first multi-agent scheduler started (with OP daily/weekly supervision)');
}

// ─────────────────────────────────────────────
// 15. Performance Monitoring API
// ─────────────────────────────────────────────

export function getAgentPerformanceMetrics() {
  return {
    ..._performanceMetrics,
    cacheHitRate: _performanceMetrics.totalCalls > 0 ? 
      (_performanceMetrics.cacheHits / _performanceMetrics.totalCalls * 100).toFixed(2) + '%' : '0%',
    contextSize: _conversationContext.size,
    cacheSize: _responseCache.size,
    quality: { ..._agentQualityMetrics },
    providerHealth: getProviderHealthStatus(),
    uptime: process.uptime()
  };
}

export function clearAgentCache() {
  _responseCache.clear();
  _conversationContext.clear();
  console.log('[agents] Cache cleared');
}

async function runAgentEvalSuite({ createdBy = '', suiteName = 'default' } = {}) {
  const rows = [];
  for (const c of AGENT_EVAL_CASES) {
    let routed = 'general';
    let err = '';
    try {
      const r = await routeMessage(c.text, false, '');
      routed = String(r?.route || 'general');
    } catch (e) {
      err = String(e?.message || e);
    }
    const demand = detectFactDemand(c.text);
    const routePass = routed === c.route;
    const demandPass = demand === c.demand;
    rows.push({
      text: c.text,
      expectedRoute: c.route,
      actualRoute: routed,
      expectedDemand: c.demand,
      actualDemand: demand,
      routePass,
      demandPass,
      error: err
    });
  }

  const total = rows.length;
  const routeHit = rows.filter((x) => x.routePass).length;
  const demandHit = rows.filter((x) => x.demandPass).length;
  const summary = {
    total,
    routeHit,
    routeAccuracy: total ? Number((routeHit / total).toFixed(3)) : 0,
    demandHit,
    demandAccuracy: total ? Number((demandHit / total).toFixed(3)) : 0,
    createdAt: new Date().toISOString(),
    cases: rows
  };

  try {
    await pool().query(
      `INSERT INTO agent_eval_runs (suite_name, summary, created_by)
       VALUES ($1, $2::jsonb, $3)`,
      [String(suiteName || 'default'), JSON.stringify(summary), String(createdBy || '')]
    );
  } catch (e) {
    console.error('[agents] runAgentEvalSuite persist failed:', e?.message || e);
  }

  return summary;
}

// 定期清理过期缓存
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [key, value] of _responseCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      _responseCache.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[agents] Cleaned ${cleaned} expired cache entries`);
  }
}, 10 * 60 * 1000); // 每10分钟清理一次

export function registerAgentRoutes(app, authRequired) {

  // ── Feishu Webhook (public, no auth) ──
  app.post('/api/feishu/webhook', async (req, res) => {
    try {
      const result = await onFeishuEvent(req.body);
      return res.json(result);
    } catch (e) {
      console.error('[feishu webhook] error:', e?.message);
      return res.status(200).json({ ok: true, error: String(e?.message || e) });
    }
  });

  // ── Admin: Agent Dashboard summary ──
  app.get('/api/agents/dashboard', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      const [issuesR, scoresR, auditsR, messagesR, usersR] = await Promise.all([
        pool().query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='open') as open, COUNT(*) FILTER (WHERE severity='high' AND status='open') as high_open FROM agent_issues`),
        pool().query(`SELECT COUNT(*) as total, ROUND(AVG(total_score)::numeric, 1) as avg_score FROM agent_scores WHERE created_at > NOW() - INTERVAL '30 days'`),
        pool().query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE result='fail') as failed, COUNT(*) FILTER (WHERE duplicate_of IS NOT NULL) as duplicates FROM agent_visual_audits WHERE created_at > NOW() - INTERVAL '30 days'`),
        pool().query(`SELECT COUNT(*) as total FROM agent_messages WHERE created_at > NOW() - INTERVAL '7 days'`),
        pool().query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE registered=TRUE) as registered FROM feishu_users`)
      ]);
      return res.json({
        issues: issuesR.rows[0],
        scores: scoresR.rows[0],
        audits: auditsR.rows[0],
        messages: { total_7d: messagesR.rows[0]?.total },
        feishuUsers: usersR.rows[0],
        performance: getAgentPerformanceMetrics()
      });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ── Performance Monitoring API ──
  app.get('/api/agents/performance', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      const metrics = getAgentPerformanceMetrics();
      res.json({ metrics });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.post('/api/agents/eval-suite/run', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      const suiteName = String(req.body?.suiteName || 'default').trim() || 'default';
      const result = await runAgentEvalSuite({ createdBy: String(req.user?.username || ''), suiteName });
      return res.json({ ok: true, result });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  app.get('/api/agents/eval-suite/runs', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const limit = Math.max(1, Math.min(50, Number(req.query?.limit) || 10));
    try {
      const r = await pool().query(
        `SELECT id, suite_name, summary, created_by, created_at
         FROM agent_eval_runs
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      return res.json({ items: r.rows || [] });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get('/api/agents/autonomous-tasks', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    const username = String(req.user?.username || '').trim();
    const status = String(req.query?.status || 'open').trim();
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
    try {
      const params = [];
      const push = (v) => { params.push(v); return `$${params.length}`; };
      const where = [];
      if (status && status !== 'all') where.push(`status = ${push(status)}`);
      if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) {
        where.push(`(owner_username = ${push(username)} OR requester_username = ${push(username)})`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const r = await pool().query(
        `SELECT id, task_type, status, store, brand, requester_username, route, reason, owner_username, notify_count, due_at, created_at, updated_at
         FROM agent_autonomous_tasks
         ${whereSql}
         ORDER BY updated_at DESC
         LIMIT ${push(limit)}`,
        params
      );
      return res.json({ items: r.rows || [] });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.post('/api/agents/autonomous-tasks/:id/resolve', authRequired, async (req, res) => {
    const id = String(req.params?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const role = String(req.user?.role || '').trim();
    const username = String(req.user?.username || '').trim();
    const note = String(req.body?.note || '').trim();
    try {
      const owned = await pool().query(`SELECT owner_username, requester_username FROM agent_autonomous_tasks WHERE id = $1 LIMIT 1`, [id]);
      const row = owned.rows?.[0] || {};
      const allowed = ['admin', 'hq_manager', 'hr_manager'].includes(role)
        || String(row.owner_username || '') === username
        || String(row.requester_username || '') === username;
      if (!allowed) return res.status(403).json({ error: 'forbidden' });

      await pool().query(
        `UPDATE agent_autonomous_tasks
         SET status = 'resolved',
             action_plan = jsonb_set(COALESCE(action_plan, '{}'::jsonb), '{resolutionNote}', to_jsonb($1::text), true),
             updated_at = NOW()
         WHERE id = $2`,
        [note || 'resolved', id]
      );
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get('/api/agents/quality-audits', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
    const route = String(req.query?.route || '').trim();
    try {
      const params = [];
      const push = (v) => { params.push(v); return `$${params.length}`; };
      const where = [];
      if (route) where.push(`route = ${push(route)}`);
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const r = await pool().query(
        `SELECT id, route, username, query_text, passed, rewrite_count, created_at
         FROM agent_quality_audits
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT ${push(limit)}`,
        params
      );
      return res.json({ items: r.rows || [] });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get('/api/agents/scheduler-status', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      res.json({ scheduler: getScheduledTaskStatus() });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ── Clear Cache API ──
  app.post('/api/agents/clear-cache', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      clearAgentCache();
      return res.json({ ok: true, message: 'Cache cleared successfully' });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ── Issues list ──
  app.get('/api/agents/issues', authRequired, async (req, res) => {
    const username = String(req.user?.username || '').trim();
    const role = String(req.user?.role || '').trim();
    const status = String(req.query?.status || '').trim();
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
    try {
      let where = ['1=1'], params = [];
      const push = v => { params.push(v); return `$${params.length}`; };
      if (role === 'store_manager' || role === 'store_production_manager') where.push(`assignee_username = ${push(username)}`);
      if (status && status !== 'all') where.push(`status = ${push(status)}`);
      const r = await pool().query(`SELECT * FROM agent_issues WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${push(limit)}`, params);
      return res.json({ items: r.rows || [] });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Resolve issue ──
  app.post('/api/agents/issues/:id/resolve', authRequired, async (req, res) => {
    const id = String(req.params?.id || '').trim();
    const resolution = String(req.body?.resolution || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_id' });
    try {
      await pool().query(`UPDATE agent_issues SET status='resolved', resolution=$1, resolved_at=NOW(), updated_at=NOW() WHERE id=$2`, [resolution, id]);
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── My Score (for profile page) ──
  app.get('/api/agent-scores/me', authRequired, async (req, res) => {
    const username = String(req.user?.username || '').trim();
    if (!username) return res.status(400).json({ error: 'missing_username' });
    try {
      const r = await pool().query(
        `SELECT total_score, breakdown, summary, period, brand, store FROM agent_scores WHERE username = $1 ORDER BY created_at DESC LIMIT 1`,
        [username]
      );
      if (!r.rows?.length) return res.json({ total_score: null, breakdown: {}, execution_rating: null, attitude_rating: null, ability_rating: null, store_rating: null });
      const row = r.rows[0];
      const breakdown = row.breakdown || {};
      return res.json({
        total_score: row.total_score,
        breakdown,
        summary: row.summary,
        period: row.period,
        brand: row.brand,
        store: row.store,
        execution_rating: breakdown.execution_rating || null,
        attitude_rating: breakdown.attitude_rating || null,
        ability_rating: breakdown.ability_rating || null,
        store_rating: breakdown.store_rating || null
      });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Scores ──
  app.get('/api/agents/scores', authRequired, async (req, res) => {
    const username = String(req.user?.username || '').trim();
    const role = String(req.user?.role || '').trim();
    const limit = Math.max(1, Math.min(100, Number(req.query?.limit) || 20));
    try {
      let where = ['1=1'], params = [];
      const push = v => { params.push(v); return `$${params.length}`; };
      if (role === 'store_manager' || role === 'store_production_manager') where.push(`username = ${push(username)}`);
      const r = await pool().query(`SELECT * FROM agent_scores WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${push(limit)}`, params);
      return res.json({ items: r.rows || [] });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Visual audits ──
  app.get('/api/agents/audits', authRequired, async (req, res) => {
    const username = String(req.user?.username || '').trim();
    const role = String(req.user?.role || '').trim();
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
    try {
      let where = ['1=1'], params = [];
      const push = v => { params.push(v); return `$${params.length}`; };
      if (role === 'store_manager' || role === 'store_production_manager') where.push(`username = ${push(username)}`);
      const r = await pool().query(`SELECT * FROM agent_visual_audits WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${push(limit)}`, params);
      return res.json({ items: r.rows || [] });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Appeals ──
  app.post('/api/agents/appeals', authRequired, async (req, res) => {
    const username = String(req.user?.username || '').trim();
    const reason = String(req.body?.reason || '').trim();
    if (!username || !reason) return res.status(400).json({ error: 'missing_params' });
    try {
      const r = await pool().query(`INSERT INTO agent_appeals (username, reason) VALUES ($1,$2) RETURNING id`, [username, reason]);
      return res.json({ ok: true, id: r.rows?.[0]?.id });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.get('/api/agents/appeals', authRequired, async (req, res) => {
    const username = String(req.user?.username || '').trim();
    const role = String(req.user?.role || '').trim();
    const limit = Math.max(1, Math.min(100, Number(req.query?.limit) || 20));
    try {
      let where = ['1=1'], params = [];
      const push = v => { params.push(v); return `$${params.length}`; };
      if (role === 'store_manager' || role === 'store_production_manager') where.push(`username = ${push(username)}`);
      const r = await pool().query(`SELECT * FROM agent_appeals WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${push(limit)}`, params);
      return res.json({ items: r.rows || [] });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Message log (admin) ──
  app.get('/api/agents/messages', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
    try {
      let where = ['1=1'], params = [];
      const push = v => { params.push(v); return `$${params.length}`; };
      if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) {
        where.push(`sender_username = ${push(req.user?.username || '')}`);
      }
      const r = await pool().query(
        `SELECT id, direction, channel, sender_username, sender_name, routed_to, content_type, content, agent_response, created_at
         FROM agent_messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${push(limit)}`, params);
      return res.json({ items: r.rows || [] });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Feishu user management (admin) ──
  app.get('/api/agents/feishu-users', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      const r = await pool().query(`SELECT * FROM feishu_users ORDER BY created_at DESC LIMIT 100`);
      return res.json({ items: r.rows || [] });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // Admin manually bind feishu user
  app.post('/api/agents/feishu-users/bind', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const openId = String(req.body?.openId || '').trim();
    const username = String(req.body?.username || '').trim();
    if (!openId || !username) return res.status(400).json({ error: 'missing_params' });
    try {
      const result = await registerFeishuUser(openId, username);
      return res.json(result);
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Manual triggers (admin) ──
  app.post('/api/agents/run/audit', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (role !== 'admin' && role !== 'hq_manager') return res.status(403).json({ error: 'forbidden' });
    try {
      const result = await runDataAuditor();
      const pushed = await pushIssuesToFeishu();
      return res.json({ ...result, feishuPushed: pushed });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post('/api/agents/run/evaluate', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (role !== 'admin' && role !== 'hq_manager') return res.status(403).json({ error: 'forbidden' });
    const period = String(req.body?.period || '').trim();
    if (!period) return res.status(400).json({ error: 'missing_period' });
    try {
      const result = await runChiefEvaluator(period);
      const pushed = await pushScoresToFeishu();
      return res.json({ ...result, feishuPushed: pushed });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Send test message to Feishu (admin) ── H2-FIX: 修复断裂的路由处理器
  app.post('/api/agents/test-feishu', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const openId = String(req.body?.openId || '').trim();
    const text = String(req.body?.text || 'HRMS Agent 测试消息').trim();
    if (!openId) return res.status(400).json({ error: 'missing_openId' });
    try {
      const result = await sendLarkMessage(openId, text);
      return res.json(result);
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Vision LLM Test (admin) ──
  app.post('/api/agents/test-vision', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const imageUrl = String(req.body?.imageUrl || '').trim();
    const prompt = String(req.body?.prompt || '请识别这张图片中的内容，判断是否为餐厅厨房环境或整改照片').trim();
    if (!imageUrl) return res.status(400).json({ error: 'missing_imageUrl' });
    try {
      const result = await callVisionLLM(imageUrl, prompt);
      return res.json({ ok: result.ok, content: result.content, error: result.error || null });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── LLM Test (admin) ──
  app.post('/api/agents/test-llm', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const prompt = String(req.body?.prompt || '请用一句话介绍潮汕菜的特点').trim();
    const model = String(req.body?.model || DEEPSEEK_MODEL).trim() || DEEPSEEK_MODEL;
    try {
      const result = await callLLM(
        [{ role: 'user', content: prompt }],
        { model, temperature: 0, max_tokens: 120, skipCache: true }
      );
      return res.json({ ok: result.ok, model, content: result.content, error: result.error || null });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Run full LLM health check now (admin/hq_manager) ──
  app.post('/api/agents/llm-health-check', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      const result = await verifyLLMHealth({ notifyOnFailure: true, notifyOnRecovery: true, forceNotify: true });
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ── Test endpoints (admin only) ──

  // Test: get feishu tenant token
  app.get('/api/agents/feishu-token-test', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      const token = await getLarkTenantToken();
      if (!token) return res.json({ ok: false, error: 'no_token — check LARK_APP_ID / LARK_APP_SECRET in .env' });
      return res.json({ ok: true, token: token.slice(0, 8) + '...' + token.slice(-4), length: token.length });
    } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  // Test: send arbitrary message to a feishu open_id
  app.post('/api/agents/feishu-send-test', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const openId = String(req.body?.openId || '').trim();
    const message = String(req.body?.message || 'HRMS Agent 测试消息').trim();
    if (!openId) return res.status(400).json({ error: 'missing openId' });
    try {
      const result = await sendLarkMessage(openId, message);
      return res.json(result);
    } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  // Test: message routing logic (no side effects)
  app.post('/api/agents/route-test', authRequired, async (req, res) => {
    const text = String(req.body?.text || '').trim();
    const hasImage = !!req.body?.hasImage;
    const route = await routeMessage(text, hasImage, String(req.user?.username || '').trim());
    const AUDIT_KEYWORDS = ['损耗', '盘点', '毛利', '牛肉', '成本', '差评', '折扣', '营收', '对账', '异常'];
    const OPS_KEYWORDS = ['图片', '卫生', '检查', '拍照', '摆盘', '收货', '消毒', '开市', '闭市', '巡检'];
    const EVAL_KEYWORDS = ['分数', '绩效', '考核', '奖金', '得分', '扣分', '排名', '评价', '这周'];
    const HR_KEYWORDS = ['离职', '辞职', '入职', '转正', '晋升', '调岗', '加薪', '薪资', '工资', '请假', '休假', '社保', '人事', '档案', '考勤'];
    const APPEAL_KEYWORDS = ['申诉', '取消扣分', '不公平', '误判', '恢复', '投诉', '举报'];
    const SOP_KEYWORDS = ['SOP', '赔付', '退款', '培训', '入职培训', '课件', '带教', '讲师', '考核培训', '技能培训', '标准作业'];
    const matched = [
      ...AUDIT_KEYWORDS.filter(k => text.includes(k)).map(k => `audit:${k}`),
      ...OPS_KEYWORDS.filter(k => text.includes(k)).map(k => `ops:${k}`),
      ...HR_KEYWORDS.filter(k => text.includes(k)).map(k => `hr:${k}`),
      ...EVAL_KEYWORDS.filter(k => text.includes(k)).map(k => `eval:${k}`),
      ...APPEAL_KEYWORDS.filter(k => text.includes(k)).map(k => `appeal:${k}`),
      ...SOP_KEYWORDS.filter(k => text.includes(k)).map(k => `train:${k}`),
    ];
    return res.json({ route, text, hasImage, matchedKeywords: matched });
  });
}

// ─────────────────────────────────────────────
// 辅助函数 - 数据源质量检查
// ─────────────────────────────────────────────

// Data Auditor 数据源质量检查
async function checkDataSourceQuality() {
  await refreshBiAgentRuntimeConfig();
  return safeExecute('data_auditor_quality_check', async () => {
    const issues = [];
    
    // 检查 Bitable 数据同步状态
    try {
      const sourceKeyByConfig = {
        ops_checklist: 'ops_checklist_bitable',
        table_visit: 'table_visit_bitable',
        opening_reports: 'opening_reports_bitable',
        closing_reports: 'closing_reports_bitable',
        meeting_reports: 'meeting_reports_bitable',
        material_majixian: 'material_majixian_bitable',
        material_hongchao: 'material_hongchao_bitable'
      };
      for (const [configKey, config] of Object.entries(BITABLE_CONFIGS)) {
        const sourceKey = sourceKeyByConfig[configKey];
        if (sourceKey && !isBiSourceEnabled(sourceKey)) continue;
        const lastSync = await getLastSyncTime(configKey);
        const syncAge = Date.now() - lastSync;
        
        // 如果超过10分钟没有同步，报告问题
        if (syncAge > 10 * 60 * 1000) {
          await safeExecute('data_source_issue_report', async () => {
            await AgentCommunicationHelper.reportDataSourceIssue(
              configKey,
              `Bitable ${config.name} 数据同步超时`,
              `最后同步时间: ${new Date(lastSync).toLocaleString()}`,
              '建议检查网络连接和API配置'
            );
          });
          issues.push(configKey);
        }
      }
    } catch (error) {
      safeErrorLog('data_auditor_bitable_sync', error);
    }
    
    // 检查数据完整性
    try {
      const state = await getSharedState();
      const reportCount = Array.isArray(state?.dailyReports) ? state.dailyReports.length : 0;
      
      if (isBiSourceEnabled('daily_reports') && reportCount < 100) {
        await safeExecute('data_completeness_report', async () => {
          await AgentCommunicationHelper.reportDataSourceIssue(
            'daily_reports',
            `营业数据量不足: ${reportCount} 条记录`,
            '可能影响异常检测准确性',
            '建议检查数据采集机制'
          );
        });
        issues.push('daily_reports');
      }
    } catch (error) {
      safeErrorLog('data_auditor_completeness', error);
    }
    
    return issues;
  }, []);
}

async function getLastSyncTime(configKey) {
  // 这里可以实现实际的同步时间检查逻辑
  // 暂时返回当前时间减去随机延迟
  return Date.now() - Math.random() * 5 * 60 * 1000;
}

// Ops Agent 任务执行质量检查
async function checkTaskExecutionQuality(storeName, brand, failedCount, duplicateCount) {
  return safeExecute('ops_agent_quality_check', async () => {
    // 如果失败率过高，报告问题
    const totalAudits = await getRecentAuditCount(storeName, 7); // 最近7天
    const failureRate = totalAudits > 0 ? failedCount / totalAudits : 0;
    
    if (failureRate > 0.15) { // 失败率超过15%
      await safeExecute('task_execution_issue_report', async () => {
        await AgentCommunicationHelper.reportTaskExecutionIssue(
          '图片审核',
          `图片审核失败率过高: ${(failureRate * 100).toFixed(1)}%`,
          failureRate,
          '建议优化审核算法或增加人工复核'
        );
      });
    }
    
    // 如果重复图片过多，报告问题
    const duplicateRate = totalAudits > 0 ? duplicateCount / totalAudits : 0;
    if (duplicateRate > 0.10) { // 重复率超过10%
      await safeExecute('duplicate_image_issue_report', async () => {
        await AgentCommunicationHelper.reportTaskExecutionIssue(
          '图片审核',
          `重复图片率过高: ${(duplicateRate * 100).toFixed(1)}%`,
          duplicateRate,
          '建议加强反作弊机制和用户教育'
        );
      });
    }
  });
}

async function getRecentAuditCount(storeName, days) {
  try {
    const result = await pool().query(`
      SELECT COUNT(*) as count 
      FROM agent_visual_audits 
      WHERE store = $1 
        AND created_at >= NOW() - make_interval(days => $2)
    `, [storeName, Math.max(1, Math.floor(Number(days) || 7))]);
    
    return Number(result.rows[0]?.count || 0);
  } catch (error) {
    console.error('[ops_agent] Failed to get audit count:', error);
    return 0;
  }
}

// 13. Weekly BI Report Scheduler (Monday 10am CST)
const REPORT_STORES = ['洪潮大宁久光店', '马己仙上海音乐广场店'];
function splitMarkdownForCard(md, maxLen = 3600) {
  const text = String(md || '');
  if (!text) return [''];
  if (text.length <= maxLen) return [text];
  const lines = text.split('\n');
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    const next = cur ? `${cur}\n${line}` : line;
    const isSectionStart = /^##\s/.test(line) || /^###\s/.test(line);
    if (next.length > maxLen && cur) {
      chunks.push(cur);
      cur = line;
      continue;
    }
    if (isSectionStart && cur.length > Math.floor(maxLen * 0.75)) {
      chunks.push(cur);
      cur = line;
      continue;
    }
    cur = next;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function sendBiReportToAdmins({ admins, title, note, md, cardTemplate = 'blue' }) {
  const chunks = splitMarkdownForCard(md, 3600);
  for (const a of admins) {
    const fu = await lookupFeishuUserByUsername(a.username);
    if (!fu?.open_id) continue;
    for (let i = 0; i < chunks.length; i += 1) {
      const card = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title },
          template: cardTemplate
        },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: chunks[i] } },
          { tag: 'note', elements: [{ tag: 'plain_text', content: note }] }
        ]
      };
      const s = await sendLarkCard(fu.open_id, card);
      if (!s.ok) {
        await sendLarkMessage(fu.open_id, prefixWithAgentName('data_auditor', chunks[i].slice(0, 3000)));
      }
    }
  }
}

export async function sendWeeklyReports() {
  console.log('[bi-report] generating weekly reports...');
  const now = new Date();
  const we = new Date(now); we.setDate(now.getDate() - now.getDay());
  const ws = new Date(we); ws.setDate(we.getDate() - 6);
  const wsS = ws.toISOString().slice(0,10), weS = we.toISOString().slice(0,10);
  const state = await getSharedState();
  const adminsRaw = [...(state?.employees||[]),...(state?.users||[])].filter(u => u?.role === 'admin');
  const seenUser = new Set();
  const admins = adminsRaw.filter(u => { const k = String(u?.username||'').trim().toLowerCase(); if (!k || seenUser.has(k)) return false; seenUser.add(k); return true; });
  for (const store of REPORT_STORES) {
    try {
      const r = await generateWeeklyReport(store, wsS, weS);
      const md = formatReportMarkdown(r);
      await sendBiReportToAdmins({
        admins,
        title: `📊 ${store} 周报`,
        note: `小年·BI周报·${wsS}~${weS}`,
        md,
        cardTemplate: 'blue'
      });
      console.log(`[bi-report] sent ${store} report to ${admins.length} admins`);
    } catch (e) { console.error(`[bi-report] ${store} failed:`, e?.message); }
  }
}

export async function sendMonthlyReports() {
  console.log('[bi-report] generating monthly reports...');
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const msS = monthStart.toISOString().slice(0, 10);
  const meS = monthEnd.toISOString().slice(0, 10);
  const state = await getSharedState();
  const adminsRaw2 = [...(state?.employees || []), ...(state?.users || [])].filter(u => u?.role === 'admin');
  const seenUser2 = new Set();
  const admins = adminsRaw2.filter(u => { const k = String(u?.username||'').trim().toLowerCase(); if (!k || seenUser2.has(k)) return false; seenUser2.add(k); return true; });
  for (const store of REPORT_STORES) {
    try {
      const r = await generateMonthlyReport(store, msS, meS);
      const md = formatReportMarkdown(r);
      await sendBiReportToAdmins({
        admins,
        title: `📈 ${store} 月报`,
        note: `小年·BI月报·${msS}~${meS}`,
        md,
        cardTemplate: 'turquoise'
      });
      console.log(`[bi-report] sent ${store} monthly report to ${admins.length} admins`);
    } catch (e) { console.error(`[bi-report] ${store} monthly failed:`, e?.message); }
  }
}

export async function sendTestReportsToUser(targetUsername) {
  console.log('[bi-report] test send to user:', targetUsername);
  const fu = await lookupFeishuUserByUsername(targetUsername);
  if (!fu?.open_id) {
    console.error('[bi-report] user not found or not bound to Feishu:', targetUsername);
    return { ok: false, error: 'user_not_found_or_not_bound', username: targetUsername };
  }
  const testAdmins = [{ username: targetUsername }];
  const now = new Date();
  const results = [];

  // 周报：上周
  const we = new Date(now); we.setDate(now.getDate() - now.getDay());
  const ws = new Date(we); ws.setDate(we.getDate() - 6);
  const wsS = ws.toISOString().slice(0, 10), weS = we.toISOString().slice(0, 10);
  for (const store of REPORT_STORES) {
    try {
      const r = await generateWeeklyReport(store, wsS, weS);
      const md = formatReportMarkdown(r);
      await sendBiReportToAdmins({ admins: testAdmins, title: `📊 ${store} 周报`, note: `小年·BI周报·${wsS}~${weS}`, md, cardTemplate: 'blue' });
      results.push({ type: 'weekly', store, ok: true });
      console.log(`[bi-report] test weekly sent: ${store} → ${targetUsername}`);
    } catch (e) {
      results.push({ type: 'weekly', store, ok: false, error: e?.message });
      console.error(`[bi-report] test weekly failed: ${store}`, e?.message);
    }
  }

  // 月报：上月
  const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const msS = monthStart.toISOString().slice(0, 10), meS = monthEnd.toISOString().slice(0, 10);
  for (const store of REPORT_STORES) {
    try {
      const r = await generateMonthlyReport(store, msS, meS);
      const md = formatReportMarkdown(r);
      await sendBiReportToAdmins({ admins: testAdmins, title: `📈 ${store} 月报`, note: `小年·BI月报·${msS}~${meS}`, md, cardTemplate: 'turquoise' });
      results.push({ type: 'monthly', store, ok: true });
      console.log(`[bi-report] test monthly sent: ${store} → ${targetUsername}`);
    } catch (e) {
      results.push({ type: 'monthly', store, ok: false, error: e?.message });
      console.error(`[bi-report] test monthly failed: ${store}`, e?.message);
    }
  }

  return { ok: true, results, targetUsername };
}

export function startWeeklyReportScheduler() {
  let lastRunDate = '';
  let lastMonthlyRunMonth = '';
  setInterval(() => {
    const n = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Shanghai'}));
    if (n.getDay()===1 && n.getHours()===10 && n.getMinutes()<5) {
      const runDate = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
      if (runDate !== lastRunDate) {
        lastRunDate = runDate;
        sendWeeklyReports().catch(e=>console.error('[bi-report] err:',e?.message));
      }
    }

    if (n.getDate()===1 && n.getHours()===10 && n.getMinutes()<5) {
      const runMonth = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;
      if (runMonth !== lastMonthlyRunMonth) {
        lastMonthlyRunMonth = runMonth;
        sendMonthlyReports().catch(e=>console.error('[bi-monthly-report] err:',e?.message));
      }
    }
  }, 60000);
  console.log('[bi-report] weekly/monthly report scheduler started (Mon 10:00 CST, monthly on day 1 10:00 CST)');
}
