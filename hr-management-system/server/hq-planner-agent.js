// ─────────────────────────────────────────────────────────────────
// HQ Planner Agent — 总部决策大脑: 策略生成 + 合规审查 + 行动计划
// ─────────────────────────────────────────────────────────────────
//
// 架构设计:
//   1. Planner (策略生成者): 基于图谱数据生成行动方案
//   2. Compliance Guard (合规审查者): 校验方案数据引用真实性 + 操作边界合法性
//   3. Plan Manager: 管理计划生命周期 (draft → pending_review → approved → executing → completed)
//
// 算力控制:
//   - 仅 admin/hq_manager/hr_manager 角色可触发
//   - 使用 HQ Brain tier 模型（高深度推理）
//   - 日调用频次受限 (≤60次/小时)
//
// 安全机制:
//   - 生成的计划不直接写库执行，必须经审批流
//   - 所有数据引用必须追溯到真实 DB 查询结果
//   - Compliance Guard 温度为0，零容忍审查
// ─────────────────────────────────────────────────────────────────

import { pool as getUnifiedPool } from './utils/database.js';
import {
  traceCausalChain,
  getStoreHealthOverview,
  crossStoreComparison,
  formatGraphContextForLLM
} from './knowledge-graph.js';
import {
  getModelForRole,
  getTemperatureForRole,
  getMaxTokensForRole,
  trackLLMCall,
  isHqRole
} from './hq-brain-config.js';

let _pool = null;
let _callLLM = null;

export function setHqPlannerPool(p) { _pool = p; }
export function setHqPlannerLLM(fn) { _callLLM = fn; }

function pool() {
  if (_pool) return _pool;
  return getUnifiedPool();
}

async function callLLMTiered(messages, role, options = {}) {
  if (!_callLLM) throw new Error('HQ Planner: callLLM not set');
  const model = getModelForRole(role, options.purpose || 'reasoning');
  const temperature = options.temperature ?? getTemperatureForRole(role);
  const maxTokens = options.maxTokens ?? getMaxTokensForRole(role);
  const result = await _callLLM(messages, {
    model,
    temperature,
    max_tokens: maxTokens,
    skipCache: true,
    ...options
  });
  // 算力追踪
  const tier = isHqRole(role) ? 'hq_brain' : 'store_limb';
  trackLLMCall(tier, result?.raw?.usage?.total_tokens || 0);
  return result;
}

// ─────────────────────────────────────────────
// 1. Strategy Planner (策略生成)
// ─────────────────────────────────────────────

export async function generateActionPlan({ store, goal, role, createdBy }) {
  if (!isHqRole(role)) {
    return { ok: false, error: 'forbidden', message: '仅总部角色可生成行动计划' };
  }

  const planId = `AP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  try {
    // Step 1: 收集图谱上下文
    const [storeHealth, causalChain] = await Promise.all([
      getStoreHealthOverview(store, 30),
      traceCausalChain('store', store, 2, 30)
    ]);

    const graphContext = formatGraphContextForLLM(causalChain, 40);

    // Step 2: 收集最近异常任务
    const recentTasks = await pool().query(
      `SELECT task_id, category, severity, title, status, score_impact, created_at
       FROM master_tasks WHERE store = $1 AND created_at > NOW() - INTERVAL '30 days'
       ORDER BY created_at DESC LIMIT 20`,
      [store]
    );

    const tasksSummary = (recentTasks.rows || []).map(t =>
      `[${t.task_id}] ${t.category}(${t.severity}) - ${t.title} - 状态:${t.status} 扣分:${t.score_impact || 0}`
    ).join('\n');

    // Step 3: 收集最近绩效数据
    const recentScores = await pool().query(
      `SELECT username, role, total_score, period, summary
       FROM agent_scores WHERE store = $1 AND created_at > NOW() - INTERVAL '60 days'
       ORDER BY created_at DESC LIMIT 10`,
      [store]
    );

    const scoresSummary = (recentScores.rows || []).map(s =>
      `${s.username}(${s.role}) ${s.period}: ${s.total_score}分 - ${String(s.summary || '').slice(0, 80)}`
    ).join('\n');

    // Step 4: LLM 生成策略 (使用 HQ Brain 高级模型)
    const plannerPrompt = `你是年年有喜餐饮集团的总部策略规划AI。你的任务是基于真实数据为门店生成可执行的改善行动计划。

## 严格规则
1. 你引用的所有数据必须来自下方提供的"数据上下文"，不得编造任何数字或事实
2. 行动计划必须具体可执行，包含：责任人角色、时间节点、验收标准
3. 每项行动必须对应一个可量化的KPI改善目标
4. 如果数据不足以支撑某项建议，必须明确标注"[数据不足]"

## 目标门店
${store}

## 改善目标
${goal || '综合提升门店运营表现'}

## 数据上下文

### 门店健康度 (近30天)
健康分: ${storeHealth.healthScore}/100
异常分布: ${JSON.stringify(storeHealth.anomalies)}
投诉分布: ${JSON.stringify(storeHealth.complaints)}
原料问题: ${JSON.stringify(storeHealth.materialIssues)}
检查情况: 总${storeHealth.inspections.total}次, 不合格${storeHealth.inspections.failed}次

### 业务关系图谱
${graphContext || '(暂无图谱数据)'}

### 近期异常任务
${tasksSummary || '(无近期异常)'}

### 绩效数据
${scoresSummary || '(无绩效数据)'}

## 输出要求
请以JSON格式返回行动计划:
{
  "title": "计划标题",
  "summary": "100字以内的计划摘要",
  "rootCauses": ["根因1", "根因2"],
  "actions": [
    {
      "priority": 1,
      "action": "具体行动描述",
      "responsibleRole": "store_manager/store_production_manager",
      "deadline": "相对天数，如7天",
      "kpiTarget": "可量化的目标",
      "verificationMethod": "验收方式"
    }
  ],
  "expectedOutcome": "预期改善效果",
  "dataGaps": ["数据不足的方面（如有）"]
}`;

    const planResult = await callLLMTiered([
      { role: 'system', content: plannerPrompt },
      { role: 'user', content: `请为 ${store} 生成改善行动计划。目标: ${goal || '综合提升'}` }
    ], role, { purpose: 'reasoning', maxTokens: 4096 });

    if (!planResult.ok) {
      return { ok: false, error: 'llm_failed', message: planResult.error };
    }

    // 解析 LLM 输出
    let planData;
    try {
      const cleaned = planResult.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      planData = JSON.parse(cleaned);
    } catch (e) {
      planData = {
        title: `${store} 改善计划`,
        summary: planResult.content.slice(0, 200),
        actions: [],
        rawContent: planResult.content
      };
    }

    // Step 5: 合规审查
    const complianceResult = await runComplianceCheck(planData, {
      store, storeHealth, graphContext, tasksSummary, scoresSummary, role
    });

    // Step 6: 存入 action_plans
    const status = complianceResult.passed ? 'pending_review' : 'compliance_rejected';
    await pool().query(
      `INSERT INTO action_plans (plan_id, title, goal, store, brand, status, plan_data, compliance_result, graph_context, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)`,
      [
        planId,
        planData.title || `${store} 改善计划`,
        goal || '综合提升',
        store,
        inferBrand(store),
        status,
        JSON.stringify(planData),
        JSON.stringify(complianceResult),
        JSON.stringify({ healthScore: storeHealth.healthScore, causalChainLength: causalChain.length }),
        createdBy || 'system'
      ]
    );

    console.log(`[hq-planner] Plan ${planId} created for ${store}, status: ${status}`);
    return {
      ok: true,
      planId,
      status,
      plan: planData,
      compliance: complianceResult,
      healthScore: storeHealth.healthScore
    };
  } catch (e) {
    console.error('[hq-planner] generateActionPlan error:', e?.message);
    return { ok: false, error: 'internal', message: e?.message };
  }
}

// ─────────────────────────────────────────────
// 2. Compliance Guard (合规审查)
// ─────────────────────────────────────────────

async function runComplianceCheck(planData, context) {
  try {
    const { store, storeHealth, graphContext, tasksSummary, scoresSummary, role } = context;

    const compliancePrompt = `你是年年有喜餐饮集团的合规审查AI。你的唯一职责是校验行动计划的合规性。

## 审查标准 (必须全部通过)

### 1. 数据真实性校验
- 计划中引用的所有数字（健康分、异常次数、绩效分）是否与提供的"真实数据"一致
- 是否存在凭空编造的统计数据或趋势

### 2. 操作边界校验
- 计划中的行动是否在系统当前能力范围内（飞书通知、任务派发、绩效扣分、培训下发）
- 是否包含系统无法执行的操作（如：直接修改供应商合同、调整菜品价格等外部操作）

### 3. 权限校验
- 计划指定的责任人角色是否合理（store_manager 或 store_production_manager）
- 是否越权操作（如门店角色审批总部决策）

## 真实数据参照
门店: ${store}
健康分: ${storeHealth?.healthScore}
异常: ${JSON.stringify(storeHealth?.anomalies || [])}
投诉: ${JSON.stringify(storeHealth?.complaints || [])}
图谱: ${graphContext?.slice(0, 500) || '无'}
任务: ${tasksSummary?.slice(0, 500) || '无'}
绩效: ${scoresSummary?.slice(0, 300) || '无'}

## 待审查的行动计划
${JSON.stringify(planData, null, 2)}

## 输出格式
{
  "passed": true/false,
  "checks": {
    "dataAccuracy": {"passed": true/false, "issues": ["问题描述"]},
    "operationBoundary": {"passed": true/false, "issues": ["问题描述"]},
    "permissionCheck": {"passed": true/false, "issues": ["问题描述"]}
  },
  "overallComment": "总体评语"
}`;

    const complianceResult = await callLLMTiered([
      { role: 'system', content: compliancePrompt },
      { role: 'user', content: '请审查上述行动计划的合规性。' }
    ], role, { purpose: 'analysis', temperature: 0, maxTokens: 2048 });

    if (!complianceResult.ok) {
      return { passed: false, error: 'compliance_llm_failed', checks: {}, overallComment: complianceResult.error };
    }

    try {
      const cleaned = complianceResult.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleaned);
    } catch (e) {
      // 保守策略: 解析失败则不通过
      return {
        passed: false,
        checks: {},
        overallComment: `合规审查解析失败: ${complianceResult.content?.slice(0, 200)}`,
        rawResponse: complianceResult.content
      };
    }
  } catch (e) {
    console.error('[hq-planner] compliance check error:', e?.message);
    return { passed: false, error: 'compliance_error', checks: {}, overallComment: e?.message };
  }
}

// ─────────────────────────────────────────────
// 3. Plan Lifecycle Management
// ─────────────────────────────────────────────

// 审批通过 → 拆解为 OP 任务
export async function approvePlan(planId, approvedBy) {
  try {
    const r = await pool().query(`SELECT * FROM action_plans WHERE plan_id = $1`, [planId]);
    const plan = r.rows?.[0];
    if (!plan) return { ok: false, error: 'not_found' };
    if (plan.status !== 'pending_review') return { ok: false, error: `invalid_status: ${plan.status}` };

    await pool().query(
      `UPDATE action_plans SET status = 'approved', approved_by = $1, updated_at = NOW() WHERE plan_id = $2`,
      [approvedBy, planId]
    );

    // 将行动计划拆解为 master_tasks
    const planData = plan.plan_data || {};
    const actions = Array.isArray(planData.actions) ? planData.actions : [];
    let createdTasks = 0;

    for (const action of actions) {
      try {
        const taskId = `AP-TASK-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`;
        await pool().query(
          `INSERT INTO master_tasks (task_id, status, source, source_ref, current_agent, category, severity, store, brand, title, detail, source_data)
           VALUES ($1, 'pending_dispatch', 'action_plan', $2, 'master', $3, 'medium', $4, $5, $6, $7, $8::jsonb)`,
          [
            taskId, planId,
            '行动计划任务',
            plan.store, plan.brand || '',
            action.action || '待执行任务',
            `来源计划: ${planId}\nKPI目标: ${action.kpiTarget || '无'}\n验收标准: ${action.verificationMethod || '无'}\n截止: ${action.deadline || '无'}`,
            JSON.stringify({ planId, priority: action.priority, responsibleRole: action.responsibleRole })
          ]
        );
        createdTasks++;
      } catch (e) {
        console.error(`[hq-planner] Failed to create task from plan action:`, e?.message);
      }
    }

    await pool().query(
      `UPDATE action_plans SET status = 'executing', updated_at = NOW() WHERE plan_id = $1`,
      [planId]
    );

    console.log(`[hq-planner] Plan ${planId} approved, created ${createdTasks} tasks`);
    return { ok: true, planId, createdTasks };
  } catch (e) {
    console.error('[hq-planner] approvePlan error:', e?.message);
    return { ok: false, error: e?.message };
  }
}

// 驳回计划
export async function rejectPlan(planId, rejectedBy, reason) {
  try {
    await pool().query(
      `UPDATE action_plans SET status = 'rejected', updated_at = NOW(),
       compliance_result = compliance_result || $1::jsonb
       WHERE plan_id = $2`,
      [JSON.stringify({ rejectedBy, rejectionReason: reason, rejectedAt: new Date().toISOString() }), planId]
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message };
  }
}

// 查询计划列表
export async function listPlans(options = {}) {
  const { store, status, limit = 20 } = options;
  const where = ['1=1'];
  const params = [];
  const push = v => { params.push(v); return `$${params.length}`; };

  if (store) where.push(`store = ${push(store)}`);
  if (status) where.push(`status = ${push(status)}`);

  const r = await pool().query(
    `SELECT * FROM action_plans WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${push(limit)}`,
    params
  );
  return r.rows || [];
}

// ─────────────────────────────────────────────
// 4. HQ Brain 对话入口 (Feishu 消息路由)
// ─────────────────────────────────────────────

export async function handleHqBrainMessage({ text, role, username, store }) {
  if (!isHqRole(role)) {
    return null; // 非 HQ 角色不处理
  }

  const t = String(text || '').trim();

  // 意图识别: 是否请求生成行动计划
  if (t.includes('行动计划') || t.includes('改善方案') || t.includes('策略') || t.includes('整改方案')) {
    // 提取目标门店
    let targetStore = store;
    const storeMatch = t.match(/(洪潮[^\s,，。]+|马己仙[^\s,，。]+)/);
    if (storeMatch) targetStore = storeMatch[1];

    // 提取目标
    const goalMatch = t.match(/目标[：:]\s*(.+?)(?=[，。\n]|$)/);
    const goal = goalMatch ? goalMatch[1] : t;

    if (!targetStore) {
      return { handled: true, response: '请指定目标门店（如：为洪潮大宁久光店生成行动计划）' };
    }

    const result = await generateActionPlan({ store: targetStore, goal, role, createdBy: username });
    if (!result.ok) {
      return { handled: true, response: `行动计划生成失败: ${result.message || result.error}` };
    }

    const planData = result.plan || {};
    const complianceTag = result.compliance?.passed ? '✅ 合规通过' : '❌ 合规未通过';
    let responseText = `📋 行动计划已生成 [${result.planId}]\n\n`;
    responseText += `门店: ${targetStore}\n`;
    responseText += `健康分: ${result.healthScore}/100\n`;
    responseText += `合规审查: ${complianceTag}\n\n`;
    responseText += `📌 ${planData.title || '改善计划'}\n`;
    responseText += `${planData.summary || ''}\n\n`;

    if (planData.rootCauses?.length) {
      responseText += `🔍 根因分析:\n${planData.rootCauses.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n`;
    }

    if (planData.actions?.length) {
      responseText += `📝 行动项:\n`;
      planData.actions.forEach((a, i) => {
        responseText += `${i + 1}. [优先级${a.priority || '-'}] ${a.action}\n`;
        responseText += `   责任: ${a.responsibleRole || '-'} | 期限: ${a.deadline || '-'} | KPI: ${a.kpiTarget || '-'}\n`;
      });
    }

    if (planData.dataGaps?.length) {
      responseText += `\n⚠️ 数据不足: ${planData.dataGaps.join('; ')}`;
    }

    if (result.status === 'pending_review') {
      responseText += `\n\n该计划已进入待审批状态。回复"审批通过 ${result.planId}"可批准执行。`;
    }

    return { handled: true, response: responseText };
  }

  // 意图识别: 门店健康度查询
  if (t.includes('健康度') || t.includes('健康分') || t.includes('门店诊断')) {
    let targetStore = store;
    const storeMatch = t.match(/(洪潮[^\s,，。]+|马己仙[^\s,，。]+)/);
    if (storeMatch) targetStore = storeMatch[1];

    if (!targetStore) {
      return { handled: true, response: '请指定门店名称（如：洪潮大宁久光店健康度）' };
    }

    const overview = await getStoreHealthOverview(targetStore, 30);
    let resp = `🏥 门店健康诊断: ${targetStore}\n\n`;
    resp += `综合健康分: ${overview.healthScore}/100\n`;
    resp += `统计区间: ${overview.period}\n\n`;

    if (overview.anomalies.length) {
      resp += `⚠️ 异常分布:\n${overview.anomalies.map(a => `  · ${a.category}: ${a.count}次 (严重度${a.severity.toFixed(1)})`).join('\n')}\n\n`;
    }
    if (overview.complaints.length) {
      resp += `📢 投诉分布:\n${overview.complaints.map(c => `  · ${c.item}: ${c.count}次`).join('\n')}\n\n`;
    }
    if (overview.materialIssues.length) {
      resp += `🥬 原料问题:\n${overview.materialIssues.map(m => `  · ${m.material}: ${m.count}次`).join('\n')}\n\n`;
    }
    resp += `📋 检查: ${overview.inspections.total}次, 不合格${overview.inspections.failed}次`;

    return { handled: true, response: resp };
  }

  // 意图识别: 因果链分析
  if (t.includes('因果') || t.includes('原因') || t.includes('为什么') || t.includes('根因')) {
    let targetStore = store;
    const storeMatch = t.match(/(洪潮[^\s,，。]+|马己仙[^\s,，。]+)/);
    if (storeMatch) targetStore = storeMatch[1];

    if (targetStore) {
      const chain = await traceCausalChain('store', targetStore, 3, 30);
      if (!chain.length) {
        return { handled: true, response: `${targetStore} 的因果关系图谱中暂无关联数据。数据将随着日常运营自动积累。` };
      }
      const formatted = formatGraphContextForLLM(chain, 20);
      return { handled: true, response: `🔗 ${targetStore} 因果关系链 (近30天):\n\n${formatted}` };
    }
  }

  // 意图识别: 审批计划
  const approveMatch = t.match(/审批通过\s*(AP-[a-z0-9-]+)/i);
  if (approveMatch) {
    const result = await approvePlan(approveMatch[1], username);
    if (result.ok) {
      return { handled: true, response: `✅ 计划 ${approveMatch[1]} 已审批通过，已拆解为 ${result.createdTasks} 个执行任务并进入派发流程。` };
    }
    return { handled: true, response: `审批失败: ${result.error}` };
  }

  // 意图识别: 跨门店对比
  if (t.includes('对比') || t.includes('比较')) {
    const storeMatches = t.match(/(洪潮[^\s,，。]+|马己仙[^\s,，。]+)/g);
    if (storeMatches?.length >= 2) {
      const comparison = await crossStoreComparison(storeMatches, 30);
      let resp = `📊 门店对比分析:\n\n`;
      for (const [s, data] of Object.entries(comparison)) {
        resp += `【${s}】健康分: ${data.healthScore}/100 | 异常${data.anomalies.length}类 | 投诉${data.complaints.length}项\n`;
      }
      return { handled: true, response: resp };
    }
  }

  // 未匹配 HQ 专属意图，返回 null 继续走常规流程
  return null;
}

// ─────────────────────────────────────────────
// 5. API Routes
// ─────────────────────────────────────────────

export function registerHqPlannerRoutes(app, authRequired) {

  // 生成行动计划
  app.post('/api/hq/plans', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!isHqRole(role)) return res.status(403).json({ error: 'forbidden' });
    const { store, goal } = req.body || {};
    if (!store) return res.status(400).json({ error: 'missing_store' });
    const result = await generateActionPlan({ store, goal, role, createdBy: req.user?.username });
    return res.json(result);
  });

  // 计划列表
  app.get('/api/hq/plans', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!isHqRole(role)) return res.status(403).json({ error: 'forbidden' });
    const plans = await listPlans({
      store: req.query?.store,
      status: req.query?.status,
      limit: Number(req.query?.limit) || 20
    });
    return res.json({ items: plans });
  });

  // 计划详情
  app.get('/api/hq/plans/:planId', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!isHqRole(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      const r = await pool().query(`SELECT * FROM action_plans WHERE plan_id = $1`, [req.params.planId]);
      if (!r.rows?.length) return res.status(404).json({ error: 'not_found' });
      return res.json(r.rows[0]);
    } catch (e) {
      return res.status(500).json({ error: e?.message });
    }
  });

  // 审批计划
  app.post('/api/hq/plans/:planId/approve', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const result = await approvePlan(req.params.planId, req.user?.username);
    return res.json(result);
  });

  // 驳回计划
  app.post('/api/hq/plans/:planId/reject', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const result = await rejectPlan(req.params.planId, req.user?.username, req.body?.reason);
    return res.json(result);
  });

  // 门店健康度
  app.get('/api/hq/store-health/:store', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!isHqRole(role)) return res.status(403).json({ error: 'forbidden' });
    const overview = await getStoreHealthOverview(req.params.store, Number(req.query?.days) || 30);
    return res.json(overview);
  });

  // 因果链查询
  app.get('/api/hq/causal-chain', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!isHqRole(role)) return res.status(403).json({ error: 'forbidden' });
    const { entityType, entityId, maxDepth, daysBack } = req.query || {};
    if (!entityType || !entityId) return res.status(400).json({ error: 'missing entityType/entityId' });
    const chain = await traceCausalChain(entityType, entityId, Number(maxDepth) || 3, Number(daysBack) || 30);
    return res.json({ chain, formatted: formatGraphContextForLLM(chain) });
  });

  // 跨门店对比
  app.post('/api/hq/compare-stores', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!isHqRole(role)) return res.status(403).json({ error: 'forbidden' });
    const { stores, daysBack } = req.body || {};
    if (!Array.isArray(stores) || stores.length < 2) return res.status(400).json({ error: 'need at least 2 stores' });
    const result = await crossStoreComparison(stores, Number(daysBack) || 30);
    return res.json(result);
  });

  // 图谱统计
  app.get('/api/hq/graph-stats', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!isHqRole(role)) return res.status(403).json({ error: 'forbidden' });
    const { getGraphStats } = await import('./knowledge-graph.js');
    const stats = await getGraphStats();
    return res.json(stats);
  });

  // 算力统计
  app.get('/api/hq/cost-stats', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const { getCostStats } = await import('./hq-brain-config.js');
    return res.json(getCostStats(Number(req.query?.days) || 7));
  });
}

// ─────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────

function inferBrand(storeName) {
  const s = String(storeName || '').trim();
  if (s.includes('洪潮')) return '洪潮传统潮汕菜';
  if (s.includes('马己仙')) return '马己仙广东小馆';
  return '';
}
