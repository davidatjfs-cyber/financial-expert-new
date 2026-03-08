/**
 * Agent Handlers - 5 sub-agents + dispatcher
 */
import { callLLM } from './llm-provider.js';
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { executeMetrics, extractTimeRangeFromText, parseTimeRange, getAllMetricDefs, quickQuery } from './data-executor.js';
import { saveMemory, recallMemories, getOutcomeStats } from './agent-memory.js';
import { generateProcurementAdvice } from './procurement-agent.js';

function matchMetrics(text, defs) {
  const t = String(text || '').toLowerCase();
  return defs.filter(d => String(d.name || '').toLowerCase().split('').some(c => t.includes(c))).slice(0, 8);
}

// ── 1. Data Auditor ──
async function handleDataAuditor(text, ctx) {
  const store = ctx.store || '';
  const tr = extractTimeRangeFromText(text);
  const { start, end, label } = parseTimeRange(tr);
  const allDefs = await getAllMetricDefs();
  const matched = matchMetrics(text, allDefs);
  let ds = '';
  if (matched.length > 0) {
    const res = await executeMetrics(matched.map(m => m.metric_id), tr, store);
    const lines = Object.values(res).filter(r => r.value !== null).map(r => `- ${r.name}: ${r.value}${r.unit || ''}`);
    if (lines.length) ds = `\n[data](${label}, ${store || 'all'})\n${lines.join('\n')}\n`;
  }
  if (!ds && store) {
    try {
      const rev = await quickQuery('daily_reports', 'SUM', 'actual_revenue', store, start, end);
      if (rev !== null) ds = `\n[data](${label},${store}) revenue:${rev}\n`;
    } catch (e) { /* silent */ }
  }
  if (!ds) ds = '\n[no data found]\n';
  // P2: 记忆回调
  try { const mem = await recallMemories('data_auditor', store, '', 3); if (mem.length) ds += '\n[历史分析]\n' + mem.map(m => m.content.slice(0,80)).join('\n'); } catch(e) {}
  const r = await callLLM([
    { role: 'system', content: '你是数据审计Agent。基于真实数据回答营收/毛利/差评问题,禁止编造数字。' + ds },
    { role: 'user', content: text }
  ], { temperature: 0.3, max_tokens: 800, purpose: 'data_auditor' });
  saveMemory('data_auditor', store, (r.content||'').slice(0,500), {query:text.slice(0,200)}).catch(()=>{});
  return { agent: 'data_auditor', response: r.content || '抱歉，无法获取数据。', data: ds, store, timeRange: tr };
}

// ── 2. Ops Supervisor ──
async function handleOpsSupervisor(text, ctx) {
  let opsData = '';
  if (ctx.store) {
    try {
      const r = await query(
        `SELECT fields->>'检查类型' as t, fields->>'得分' as s FROM feishu_generic_records
         WHERE (fields->>'所属门店' ILIKE $1 OR fields->>'门店' ILIKE $1) ORDER BY created_at DESC LIMIT 5`,
        [`%${ctx.store}%`]);
      if (r.rows?.length) opsData = r.rows.map(row => `${row.t||'检查'}:${row.s||'-'}`).join('; ');
    } catch (e) { /* silent */ }
  }
  // P2: 记忆回调
  try { const mem = await recallMemories('ops_supervisor', ctx.store||'', '', 3); if (mem.length) opsData += '\n[历史巡检] ' + mem.map(m => m.content.slice(0,80)).join('; '); } catch(e) {}
  const r = await callLLM([
    { role: 'system', content: '你是营运督导Agent。处理开市/收市检查、卫生巡检、门店运营标准。' + (opsData ? `\n[近期检查]${opsData}` : '') },
    { role: 'user', content: text }
  ], { temperature: 0.3, max_tokens: 600, purpose: 'ops_supervisor' });
  saveMemory('ops_supervisor', ctx.store||'', (r.content||'').slice(0,500), {query:text.slice(0,200)}).catch(()=>{});
  return { agent: 'ops_supervisor', response: r.content || '请描述巡检需求。', store: ctx.store };
}

async function handleChiefEvaluator(text, ctx) {
  let evidence = '';
  const store = ctx.store || '';
  if (store) {
    try {
      const [anom, scores] = await Promise.all([
        query(`SELECT category, severity, COUNT(*)::int as cnt FROM anomaly_triggers
               WHERE store ILIKE $1 AND trigger_date >= CURRENT_DATE - INTERVAL '30 days'
               GROUP BY category, severity ORDER BY cnt DESC LIMIT 10`, [`%${store}%`]),
        query(`SELECT role, score, rating, period_start, period_end FROM agent_scores
               WHERE store ILIKE $1 ORDER BY period_end DESC LIMIT 5`, [`%${store}%`])
      ]);
      if (anom.rows?.length) evidence += '\n[近30天异常] ' + anom.rows.map(r => `${r.category}(${r.severity}):${r.cnt}次`).join(', ');
      if (scores.rows?.length) evidence += '\n[历史评分] ' + scores.rows.map(r => `${r.role}:${r.score}分/${r.rating}级(${r.period_end?.toISOString?.().slice(0,10)||''})`).join(', ');
    } catch (e) { logger.warn({ err: e?.message }, 'chief_evaluator data fetch'); }
  }
  if (!evidence) evidence = '\n[no scoring data found]';
  // P2: 记忆回调
  try { const mem = await recallMemories('chief_evaluator', store, '', 3); if (mem.length) evidence += '\n[历史评估] ' + mem.map(m => m.content.slice(0,80)).join('; '); } catch(e) {}
  const r = await callLLM([
    { role: 'system', content: '你是绩效考核Agent。基于真实扣分记录和异常数据分析绩效,禁止编造数字。' + evidence },
    { role: 'user', content: text }
  ], { temperature: 0.3, max_tokens: 600, purpose: 'chief_evaluator' });
  saveMemory('chief_evaluator', store, (r.content||'').slice(0,500), {query:text.slice(0,200)}).catch(()=>{});
  return { agent: 'chief_evaluator', response: r.content || '暂无评分数据', data: evidence, store };
}
async function handleTrainAdvisor(text, ctx) {
  let kbData = '';
  try {
    const kb = await query(
      `SELECT title, content FROM knowledge_base
       WHERE category IN ('sop','training','procedure') AND enabled = true
       AND (title ILIKE $1 OR content ILIKE $1) LIMIT 5`,
      [`%${text.slice(0, 30)}%`]);
    if (kb.rows?.length) kbData = '\n[相关SOP/培训资料]\n' + kb.rows.map(r => `### ${r.title}\n${String(r.content).slice(0, 300)}`).join('\n');
  } catch (e) { /* KB table may not exist yet */ }
  if (!kbData) kbData = '\n[暂无匹配SOP资料]';
  // P2: 记忆回调
  try { const mem = await recallMemories('train_advisor', '', text.slice(0,30), 3); if (mem.length) kbData += '\n[历史培训问答] ' + mem.map(m => m.content.slice(0,80)).join('; '); } catch(e) {}
  const r = await callLLM([
    { role: 'system', content: '你是培训SOP Agent。基于知识库中的SOP和培训资料回答,如无资料请明确告知。' + kbData },
    { role: 'user', content: text }
  ], { temperature: 0.3, max_tokens: 800, purpose: 'train_advisor' });
  saveMemory('train_advisor', '', (r.content||'').slice(0,500), {query:text.slice(0,200)}).catch(()=>{});
  return { agent: 'train_advisor', response: r.content || '请描述培训需求', data: kbData };
}
async function handleAppeal(text, ctx) {
  let appealData = '';
  const store = ctx.store || '', user = ctx.username || '';
  try {
    const [sc, anom] = await Promise.all([
      query(`SELECT role, score, rating, deduction_total, period_start, period_end FROM agent_scores
             WHERE (store ILIKE $1 OR username = $2) ORDER BY period_end DESC LIMIT 3`,
            [`%${store}%`, user]),
      query(`SELECT category, severity, description, trigger_date FROM anomaly_triggers
             WHERE (store ILIKE $1) AND trigger_date >= CURRENT_DATE - INTERVAL '60 days'
             ORDER BY trigger_date DESC LIMIT 10`, [`%${store}%`])
    ]);
    if (sc.rows?.length) appealData += '\n[你的评分记录]\n' + sc.rows.map(r => `${r.period_end?.toISOString?.().slice(0,10)||''}: ${r.score}分 ${r.rating}级 扣${r.deduction_total||0}分`).join('\n');
    if (anom.rows?.length) appealData += '\n[近60天异常扣分项]\n' + anom.rows.map(r => `${r.trigger_date?.toISOString?.().slice(0,10)||''} ${r.category}(${r.severity}): ${r.description||''}`).join('\n');
  } catch (e) { /* silent */ }
  if (!appealData) appealData = '\n[暂无评分/扣分记录]';
  // P2: 记忆回调
  try { const mem = await recallMemories('appeal', store, '', 3); if (mem.length) appealData += '\n[历史申诉] ' + mem.map(m => m.content.slice(0,80)).join('; '); } catch(e) {}
  const r = await callLLM([
    { role: 'system', content: '你是申诉Agent。基于用户的实际扣分记录处理申诉,需要用户提供具体申诉理由和证据。' + appealData },
    { role: 'user', content: text }
  ], { temperature: 0.3, max_tokens: 600, purpose: 'appeal' });
  saveMemory('appeal', store, (r.content||'').slice(0,500), {query:text.slice(0,200)}).catch(()=>{});
  return { agent: 'appeal', response: r.content || '请描述申诉内容', data: appealData, store };
}
// ── 7. Marketing Planner (营销策划) ──
async function handleMarketingPlanner(text, ctx) {
  let mktData = '';
  const store = ctx.store || '';
  try {
    // 拉取近30天营收趋势 + 达成率
    const rev = await query(
      `SELECT date, actual_revenue, budget, budget_rate, pre_discount_revenue, delivery_actual
       FROM daily_reports WHERE store ILIKE $1 AND date >= CURRENT_DATE - 30
       ORDER BY date DESC LIMIT 30`, [`%${store}%`]);
    if (rev.rows?.length) {
      const avg = rev.rows.reduce((s, r) => s + (parseFloat(r.actual_revenue) || 0), 0) / rev.rows.length;
      const avgRate = rev.rows.reduce((s, r) => s + (parseFloat(r.budget_rate) || 0), 0) / rev.rows.length;
      mktData += `\n[近30天营收] 均值:${Math.round(avg)}元 达成率:${(avgRate * 100).toFixed(1)}% 天数:${rev.rows.length}`;
      const recent7 = rev.rows.slice(0, 7);
      mktData += '\n近7天: ' + recent7.map(r => `${r.date?.toISOString?.().slice(5, 10)||''}:${r.actual_revenue||0}`).join(', ');
    }
    // 拉取进行中的营销活动
    const campaigns = await query(
      `SELECT title, status, start_date, end_date, target_metric, target_value
       FROM marketing_campaigns WHERE (store ILIKE $1 OR store IS NULL)
       AND status IN ('active','planned') ORDER BY start_date DESC LIMIT 5`, [`%${store}%`]);
    if (campaigns.rows?.length) {
      mktData += '\n[进行中营销活动]\n' + campaigns.rows.map(c => `${c.title}(${c.status}) ${c.start_date?.toISOString?.().slice(0,10)||''}-${c.end_date?.toISOString?.().slice(0,10)||''} 目标:${c.target_metric}=${c.target_value}`).join('\n');
    }
    // 差评分析（服务+产品）
    const reviews = await query(
      `SELECT category, severity, COUNT(*)::int as cnt FROM anomaly_triggers
       WHERE store ILIKE $1 AND category IN ('product_review','service_review')
       AND trigger_date >= CURRENT_DATE - 30 GROUP BY category, severity`, [`%${store}%`]);
    if (reviews.rows?.length) mktData += '\n[近30天差评] ' + reviews.rows.map(r => `${r.category}(${r.severity}):${r.cnt}次`).join(', ');
  } catch (e) { logger.warn({ err: e?.message }, 'marketing_planner data'); }
  if (!mktData) mktData = '\n[暂无门店营收数据]';
  // 检索历史记忆
  try {
    const memories = await recallMemories('marketing_planner', store, '', 3);
    if (memories.length) {
      mktData += '\n[历史方案记录]\n' + memories.map(m => {
        const score = m.outcome_score ? `(效果:${m.outcome_score}/10)` : '';
        return `${m.created_at?.toISOString?.().slice(0,10)||''}: ${m.content.slice(0,100)}${score}`;
      }).join('\n');
    }
    const stats = await getOutcomeStats('marketing_planner', store);
    if (stats.total > 0) mktData += `\n[历史效果] ${stats.total}次方案 平均分:${stats.avg_score||'N/A'} 成功:${stats.success_count}次`;
  } catch (e) { /* silent */ }
  const r = await callLLM([
    { role: 'system', content: `你是市场部营销策划Agent。职责：
1. 分析门店营收数据、达成率、客流趋势，找出问题根因
2. 基于数据制定针对性营销方案（会员活动、外卖促销、新品推广、节假日活动等）
3. 评估现有营销活动效果
4. 给出具体可执行的营销建议，包含预算、时间、预期效果
禁止编造数字，必须基于真实数据分析。` + mktData },
    { role: 'user', content: text }
  ], { temperature: 0.4, max_tokens: 1000, purpose: 'marketing_planner' });
  // 保存记忆
  saveMemory('marketing_planner', store, (r.content || '').slice(0, 500), { query: text.slice(0, 200) }).catch(() => {});
  return { agent: 'marketing_planner', response: r.content || '请提供门店信息', data: mktData, store };
}

// ── 8. Marketing Executor (营销执行) ──
async function handleMarketingExecutor(text, ctx) {
  let execData = '';
  const store = ctx.store || '';
  try {
    // 拉取该门店所有营销活动及执行状态
    const camps = await query(
      `SELECT id, title, status, start_date, end_date, target_metric, target_value,
              actual_value, budget_amount, spent_amount, notes
       FROM marketing_campaigns WHERE (store ILIKE $1 OR store IS NULL)
       ORDER BY start_date DESC LIMIT 10`, [`%${store}%`]);
    if (camps.rows?.length) {
      execData += '\n[营销活动清单]\n' + camps.rows.map(c => {
        const progress = c.actual_value && c.target_value ? ((parseFloat(c.actual_value) / parseFloat(c.target_value)) * 100).toFixed(0) + '%' : 'N/A';
        return `[${c.status}] ${c.title} | ${c.start_date?.toISOString?.().slice(0,10)||''}-${c.end_date?.toISOString?.().slice(0,10)||''} | 进度:${progress} | 预算:${c.budget_amount||'N/A'}/已花:${c.spent_amount||0}`;
      }).join('\n');
    }
    // 拉取营销相关任务
    const tasks = await query(
      `SELECT title, status, severity, created_at FROM master_tasks
       WHERE store ILIKE $1 AND title ILIKE '%营销%' OR title ILIKE '%活动%' OR title ILIKE '%促销%'
       ORDER BY created_at DESC LIMIT 5`, [`%${store}%`]);
    if (tasks.rows?.length) execData += '\n[相关任务] ' + tasks.rows.map(t => `${t.title}(${t.status})`).join(', ');
  } catch (e) { logger.warn({ err: e?.message }, 'marketing_executor data'); }
  if (!execData) execData = '\n[暂无营销活动数据]';
  // P2: 记忆回调
  try { const mem = await recallMemories('marketing_executor', store, '', 3); if (mem.length) execData += '\n[历史执行记录] ' + mem.map(m => m.content.slice(0,80)).join('; '); } catch(e) {}
  const r = await callLLM([
    { role: 'system', content: `你是市场部营销执行Agent。职责：
1. 跟踪所有进行中的营销活动执行进度
2. 对比实际效果与目标，发现执行偏差
3. 提出执行调整建议（加大投入/缩减/换方向）
4. 汇报活动ROI和预算消耗
5. 创建营销执行任务并跟进闭环
禁止编造数字，必须基于真实数据。` + execData },
    { role: 'user', content: text }
  ], { temperature: 0.4, max_tokens: 800, purpose: 'marketing_executor' });
  saveMemory('marketing_executor', store, (r.content||'').slice(0,500), {query:text.slice(0,200)}).catch(()=>{});
  return { agent: 'marketing_executor', response: r.content || '请描述营销执行需求', data: execData, store };
}

// ── 9. Procurement Advisor (采购建议) ──
async function handleProcurementAdvisor(text, ctx) {
  const store = ctx.store || '';
  if (!store) {
    return { agent: 'procurement_advisor', response: '请提供门店名称以便生成采购建议。' };
  }
  const advice = await generateProcurementAdvice(store);
  let resp = `## 采购建议 - ${store}\n\n**${advice.summary || ''}**\n\n`;
  if (advice.suggestions?.length) {
    resp += advice.suggestions.map((s, i) => `${i + 1}. **${s.category}**: ${s.action === 'increase' ? '↑增加' : s.action === 'decrease' ? '↓减少' : '→维持'} — ${s.reason}${s.estimated_saving ? ` (预估节省¥${s.estimated_saving})` : ''}`).join('\n');
  }
  if (advice.warnings?.length) resp += '\n\n⚠️ ' + advice.warnings.join('\n⚠️ ');
  resp += `\n\n_下次复查: ${advice.next_review_days || 7}天后_`;
  saveMemory('procurement_advisor', store, (resp||'').slice(0,500), {query:text.slice(0,200)}).catch(()=>{});
  return { agent: 'procurement_advisor', response: resp, data: advice, store };
}

async function handleMaster(t,c){
  const memories = [];
  try {
    const mem = await recallMemories('master', c.store || '', '', 3);
    if (mem.length) memories.push('\n[历史记录]\n' + mem.map(m => m.content.slice(0,100)).join('\n'));
  } catch(e) { /* silent */ }
  const r=await callLLM([{role:'system',content:`你是HRMS系统的Master Agent（调度中枢）。职责：
1. 综合回答无法归类到具体子Agent的通用问题
2. 协调跨Agent的复杂任务
3. 管理任务状态流转和优先级
4. 监控整体系统运行状态
基于真实数据回答，禁止编造。${memories.join('')}`},{role:'user',content:t}],{temperature:0.3,max_tokens:600,purpose:'master'});
  saveMemory('master', c.store||'', (r.content||'').slice(0,500), {query:t.slice(0,200)}).catch(()=>{});
  return{agent:'master',response:r.content||'您好，请描述您的需求。'};
}
const HANDLERS={data_auditor:handleDataAuditor,ops_supervisor:handleOpsSupervisor,chief_evaluator:handleChiefEvaluator,train_advisor:handleTrainAdvisor,appeal:handleAppeal,marketing_planner:handleMarketingPlanner,marketing_executor:handleMarketingExecutor,procurement_advisor:handleProcurementAdvisor,marketing:handleMarketingPlanner,food_quality:handleOpsSupervisor,master:handleMaster};
export async function dispatchToAgent(route,text,ctx={}){const h=HANDLERS[route]||HANDLERS.master;const t0=Date.now();try{const r=await h(text,ctx);r.latencyMs=Date.now()-t0;return r;}catch(e){return{agent:route,response:'出错请重试',error:e?.message};}}
export{HANDLERS};
