import { pool } from './agents.js';

const DEFAULT_AGENTS = [
  {
    agent_id: 'master',
    name: 'Master Agent (调度中枢)',
    description: '作为唯一的飞书 API 入口，负责消息路由、任务状态流转和全局上下文管理',
    system_prompt: '你是 HRMS 系统的 Master Agent，负责调度和任务流转。',
    model_name: 'qwen-plus',
    temperature: 0.1,
    enabled: true,
    schedule_interval: 1
  },
  {
    agent_id: 'data_auditor',
    name: 'Data Auditor Agent (数据审计)',
    description: '核对来源数据，对异常情况触发预警',
    system_prompt: '你是数据审计 Agent，负责从业务报表和客诉数据中发现异常。',
    model_name: 'qwen-plus',
    temperature: 0.1,
    enabled: true,
    schedule_interval: 30
  },
  {
    agent_id: 'ops_supervisor',
    name: 'Ops Agent (营运督导)',
    description: '负责飞书端的任务分派、到点提醒、以及利用 Vision 能力审核员工上传的照片',
    system_prompt: '你是营运督导 Agent，负责跟进异常任务的整改并审核照片。',
    model_name: 'qwen-vl-plus',
    temperature: 0.2,
    enabled: true,
    schedule_interval: 1
  },
  {
    agent_id: 'sop_advisor',
    name: 'SOP Agent (标准库)',
    description: '管理所有运营标准，提供 RAG 知识检索，支撑其他 Agent 的判罚依据',
    system_prompt: '你是 SOP 顾问 Agent，负责解答运营标准相关问题。',
    model_name: 'qwen-plus',
    temperature: 0.1,
    enabled: true,
    schedule_interval: 0
  },
  {
    agent_id: 'chief_evaluator',
    name: 'Chief Evaluator (绩效考核)',
    description: '根据行为和数据结果，自动计算奖金，评分，评级的功能',
    system_prompt: '你是绩效考核 Agent，负责根据任务解决情况进行扣分和结算。',
    model_name: 'qwen-plus',
    temperature: 0.1,
    enabled: true,
    schedule_interval: 60
  },
  {
    agent_id: 'appeal_handler',
    name: 'Appeal Agent (申诉处理)',
    description: '处理员工反馈，核实证据，并具备人工介入仲裁的逻辑',
    system_prompt: '你是申诉处理 Agent，负责处理员工对扣分或处罚的异议。',
    model_name: 'qwen-plus',
    temperature: 0.2,
    enabled: true,
    schedule_interval: 0
  }
];

const DEFAULT_RULES = [
  { category: '桌访异常', assignee_role: 'store_production_manager', normal_deduction: 2, major_deduction: 5 },
  { category: '桌访连续投诉', assignee_role: 'store_production_manager', normal_deduction: 5, major_deduction: 10 },
  { category: '桌访占比异常', assignee_role: 'store_manager', normal_deduction: 2, major_deduction: 5 },
  { category: '实收营收异常', assignee_role: 'store_manager', normal_deduction: 2, major_deduction: 5 },
  { category: '人效值异常', assignee_role: 'store_manager', normal_deduction: 2, major_deduction: 5 },
  { category: '充值异常', assignee_role: 'store_manager', normal_deduction: 2, major_deduction: 5 },
  { category: '总实收毛利率异常', assignee_role: 'store_production_manager', normal_deduction: 5, major_deduction: 10 },
  { category: '产品差评异常', assignee_role: 'store_production_manager', normal_deduction: 10, major_deduction: 15 },
  { category: '服务差评异常', assignee_role: 'store_manager', normal_deduction: 10, major_deduction: 15 },
  { category: '图片审核不合格', assignee_role: 'store_production_manager', normal_deduction: 2, major_deduction: 5 }
];

export async function ensureAgentConfigTables() {
  try {
    await pool().query('create extension if not exists pgcrypto');
    
    // 1. Agent 基础配置表
    await pool().query(`
      create table if not exists agent_configs (
        id uuid primary key default gen_random_uuid(),
        agent_id varchar(50) unique not null,
        name varchar(100) not null,
        description text,
        system_prompt text,
        model_name varchar(50) default 'qwen-plus',
        temperature decimal(3,2) default 0.1,
        enabled boolean default true,
        schedule_interval int default 30,
        updated_at timestamp default current_timestamp
      )
    `);

    // 2. 异常扣分与责任人路由规则表
    await pool().query(`
      create table if not exists agent_rules (
        id uuid primary key default gen_random_uuid(),
        category varchar(100) unique not null,
        assignee_role varchar(100) not null,
        normal_deduction int default 10,
        major_deduction int default 20,
        enabled boolean default true,
        updated_at timestamp default current_timestamp
      )
    `);

    // 初始化默认 Agent 数据
    for (const agent of DEFAULT_AGENTS) {
      await pool().query(`
        insert into agent_configs (agent_id, name, description, system_prompt, model_name, temperature, enabled, schedule_interval)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (agent_id) do nothing
      `, [agent.agent_id, agent.name, agent.description, agent.system_prompt, agent.model_name, agent.temperature, agent.enabled, agent.schedule_interval]);
    }

    // 初始化默认 Rule 数据
    for (const rule of DEFAULT_RULES) {
      await pool().query(`
        insert into agent_rules (category, assignee_role, normal_deduction, major_deduction)
        values ($1, $2, $3, $4)
        on conflict (category) do nothing
      `, [rule.category, rule.assignee_role, rule.normal_deduction, rule.major_deduction]);
    }
    
    console.log('[AgentConfig] Tables ensured and default data seeded.');
  } catch (e) {
    console.error('[AgentConfig] Init error:', e);
  }
}

export function registerAgentConfigRoutes(app, authRequired) {
  // === Agent Configs ===
  app.get('/api/admin/agents/configs', authRequired, async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    try {
      const r = await pool().query('select * from agent_configs order by agent_id');
      res.json({ configs: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/admin/agents/configs/:agent_id', authRequired, async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const agentId = req.params.agent_id;
    const { system_prompt, model_name, temperature, enabled, schedule_interval } = req.body;
    try {
      const r = await pool().query(`
        update agent_configs 
        set system_prompt = $1, model_name = $2, temperature = $3, enabled = $4, schedule_interval = $5, updated_at = now()
        where agent_id = $6 returning *
      `, [system_prompt, model_name, temperature, enabled, schedule_interval, agentId]);
      res.json({ config: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // === Agent Rules ===
  app.get('/api/admin/agents/rules', authRequired, async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    try {
      const r = await pool().query('select * from agent_rules order by category');
      res.json({ rules: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/admin/agents/rules/:id', authRequired, async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const id = req.params.id;
    const { category, assignee_role, normal_deduction, major_deduction, enabled } = req.body;
    try {
      const r = await pool().query(`
        update agent_rules 
        set category = $1, assignee_role = $2, normal_deduction = $3, major_deduction = $4, enabled = $5, updated_at = now()
        where id = $6 returning *
      `, [category, assignee_role, normal_deduction, major_deduction, enabled, id]);
      res.json({ rule: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/agents/rules', authRequired, async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const { category, assignee_role, normal_deduction, major_deduction, enabled } = req.body;
    try {
      const r = await pool().query(`
        insert into agent_rules (category, assignee_role, normal_deduction, major_deduction, enabled)
        values ($1, $2, $3, $4, $5) returning *
      `, [category, assignee_role, normal_deduction, major_deduction, enabled !== false]);
      res.json({ rule: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/admin/agents/rules/:id', authRequired, async (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const id = req.params.id;
    try {
      await pool().query('delete from agent_rules where id = $1', [id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

// 缓存相关的辅助函数
let cachedRules = null;
let rulesLastFetched = 0;
const CACHE_TTL = 60 * 1000; // 1 分钟缓存

export async function getAgentRules() {
  const now = Date.now();
  if (cachedRules && (now - rulesLastFetched < CACHE_TTL)) {
    return cachedRules;
  }
  try {
    const r = await pool().query('select * from agent_rules where enabled = true');
    cachedRules = r.rows;
    rulesLastFetched = now;
    return cachedRules;
  } catch (e) {
    console.error('[getAgentRules] Error:', e);
    return [];
  }
}

export async function getCategoryAssigneeRoleMap() {
  const rules = await getAgentRules();
  const map = {};
  for (const rule of rules) {
    map[rule.category] = rule.assignee_role;
  }
  return map;
}

export async function getIssueScoreRulesMap() {
  const rules = await getAgentRules();
  const map = {};
  for (const rule of rules) {
    map[rule.category] = {
      normal: rule.normal_deduction,
      major: rule.major_deduction
    };
  }
  return map;
}

let cachedConfigs = null;
let configsLastFetched = 0;

export async function getAgentConfigs() {
  const now = Date.now();
  if (cachedConfigs && (now - configsLastFetched < CACHE_TTL)) {
    return cachedConfigs;
  }
  try {
    const r = await pool().query('select * from agent_configs');
    const map = {};
    for (const row of r.rows) {
      map[row.agent_id] = row;
    }
    cachedConfigs = map;
    configsLastFetched = now;
    return cachedConfigs;
  } catch (e) {
    console.error('[getAgentConfigs] Error:', e);
    return {};
  }
}

export async function getAgentConfig(agentId) {
  const configs = await getAgentConfigs();
  return configs[agentId] || null;
}
