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

const DEFAULT_PROMPT_TEMPLATES = [
  { template_key: 'master_default_v1', agent_id: 'master', name: 'Master 默认模板', content: '你是 HRMS 系统的 Master Agent，负责调度和任务流转。', enabled: true, is_builtin: true },
  { template_key: 'data_auditor_default_v1', agent_id: 'data_auditor', name: 'BI 默认模板', content: '你是数据审计 Agent，负责从业务报表和客诉数据中发现异常。', enabled: true, is_builtin: true },
  { template_key: 'ops_supervisor_default_v1', agent_id: 'ops_supervisor', name: 'OP 默认模板', content: '你是营运督导 Agent，负责跟进异常任务的整改并审核照片。', enabled: true, is_builtin: true },
  { template_key: 'sop_advisor_default_v1', agent_id: 'sop_advisor', name: 'SOP 默认模板', content: '你是 SOP 顾问 Agent，负责解答运营标准相关问题。', enabled: true, is_builtin: true },
  { template_key: 'appeal_handler_default_v1', agent_id: 'appeal_handler', name: '申诉 默认模板', content: '你是申诉处理 Agent，负责处理员工对扣分或处罚的异议。', enabled: true, is_builtin: true }
];

const DEFAULT_EMPLOYEE_RATING_CONFIG = {
  execution: {
    store_production_manager: { threshold_A: 1, threshold_B: 3, threshold_C: 9999 },
    store_manager: {
      hongchao: { min_A: 300, min_B: 200, min_C: 0 },
      majixian: { low_score_threshold: 85, max_missing_A: 0, max_low_A: 0, max_missing_B: 1, max_low_B: 1, max_missing_C: 999, max_low_C: 999 }
    }
  },
  attitude: { threshold_A: 0, threshold_B: 2 },
  ability: {
    store_production_manager: { min_A: -0.01, min_B: -0.02, max_B: -0.01, min_C: -99, max_C: -0.02 },
    store_manager: {
      hongchao: { min_A: 4.8, min_B: 4.5, min_C: 0 },
      majixian: { min_A: 4.5, min_B: 4.0, min_C: 0 }
    }
  }
};

export const DEFAULT_OPS_AGENT_CONFIG = {
  dispatchers: ['store_manager', 'store_production_manager'], // 派单人员角色
  scheduledTasks: {
    dailyInspections: [
      { brand: '洪潮', type: 'opening', time: '10:30', checklist: ['地面清洁无积水', '所有设备正常开启', '食材新鲜度检查', '餐具消毒完成', '灯光亮度适中', '背景音乐开启', '空调温度设置合适', '员工仪容仪表检查'] },
      { brand: '马己仙', type: 'opening', time: '10:00', checklist: ['地面清洁', '设备开启', '食材准备', '餐具消毒', '迎宾准备'] },
      { brand: '洪潮', type: 'closing', time: '22:00', checklist: ['食材封存', '设备关闭', '垃圾清理', '安全检查', '门窗锁好'] },
      { brand: '马己仙', type: 'closing', time: '22:30', checklist: ['食材封存', '设备关闭', '垃圾清理', '安全检查', '门窗锁好', '电源关闭'] }
    ],
    randomInspections: [
      { type: 'seafood_pool_temperature', description: '拍摄海鲜池水温计照片', timeWindow: 15 },
      { type: 'fridge_label_check', description: '检查冰箱标签是否过期', timeWindow: 10 },
      { type: 'hand_washing_duration', description: '录制洗手20秒视频', timeWindow: 5 }
    ],
    dataTriggers: {
      productComplaintThreshold: 2, 
      marginDeviationThreshold: 0.01,
      tableVisitRatioThreshold: 0.50  
    }
  }
};

function toJson(v, fallback = {}) {
  try { return typeof v === 'string' ? JSON.parse(v) : (v || fallback); } catch (_) { return fallback; }
}

function validateEmployeeRatingConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const ex = cfg.execution || {};
  const at = cfg.attitude || {};
  const ab = cfg.ability || {};
  const ePm = ex.store_production_manager || {};
  const eMgrHz = ex.store_manager?.hongchao || {};
  const eMgrMjx = ex.store_manager?.majixian || {};
  const a = at || {};
  const bPm = ab.store_production_manager || {};
  const bMgrHz = ab.store_manager?.hongchao || {};
  const bMgrMjx = ab.store_manager?.majixian || {};
  const checks = [
    ePm.A_max_missing, ePm.B_max_missing, ePm.C_max_missing,
    eMgrHz.A_min_new_members, eMgrHz.B_min_new_members, eMgrHz.C_min_new_members,
    eMgrMjx.low_score_threshold, eMgrMjx.A_max_missing, eMgrMjx.A_max_low_score,
    eMgrMjx.B_max_missing, eMgrMjx.B_max_low_score, eMgrMjx.C_max_missing, eMgrMjx.C_max_low_score,
    a.A_max_incomplete, a.B_max_incomplete,
    bPm.A_min_diff, bPm.B_min_diff, bPm.B_max_diff, bPm.C_min_diff, bPm.C_max_diff,
    bMgrHz.A_min_rating, bMgrHz.B_min_rating, bMgrHz.C_min_rating,
    bMgrMjx.A_min_rating, bMgrMjx.B_min_rating, bMgrMjx.C_min_rating
  ];
  return checks.every((v) => Number.isFinite(Number(v)));
}

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

    await pool().query(`
      alter table agent_configs
      add column if not exists prompt_template_id uuid
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

    await pool().query(`
      create table if not exists agent_prompt_templates (
        id uuid primary key default gen_random_uuid(),
        template_key varchar(120) unique not null,
        agent_id varchar(50) not null,
        name varchar(120) not null,
        content text not null,
        enabled boolean default true,
        is_builtin boolean default false,
        created_at timestamp default current_timestamp,
        updated_at timestamp default current_timestamp
      )
    `);

    await pool().query(`
      create table if not exists hr_rating_configs (
        id uuid primary key default gen_random_uuid(),
        config_key varchar(80) unique not null,
        config jsonb not null,
        enabled boolean default true,
        updated_at timestamp default current_timestamp
      )
    `);

    await pool().query(`
      alter table agent_configs
      add constraint fk_agent_prompt_template
      foreign key (prompt_template_id) references agent_prompt_templates(id)
      on delete set null
    `).catch(() => null);

    const templateIdMap = {};
    for (const tpl of DEFAULT_PROMPT_TEMPLATES) {
      const tr = await pool().query(
        `insert into agent_prompt_templates (template_key, agent_id, name, content, enabled, is_builtin)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (template_key)
         do update set name = excluded.name, content = excluded.content, enabled = excluded.enabled, updated_at = now()
         returning id, template_key`,
        [tpl.template_key, tpl.agent_id, tpl.name, tpl.content, tpl.enabled !== false, tpl.is_builtin === true]
      );
      const row = tr.rows?.[0];
      if (row?.template_key && row?.id) templateIdMap[row.template_key] = row.id;
    }

    // 初始化默认 Agent 数据
    for (const agent of DEFAULT_AGENTS) {
      const defaultTpl = DEFAULT_PROMPT_TEMPLATES.find((x) => x.agent_id === agent.agent_id);
      const promptTemplateId = defaultTpl ? (templateIdMap[defaultTpl.template_key] || null) : null;
      await pool().query(`
        insert into agent_configs (agent_id, name, description, system_prompt, model_name, temperature, enabled, schedule_interval, prompt_template_id)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict (agent_id) do nothing
      `, [agent.agent_id, agent.name, agent.description, agent.system_prompt, agent.model_name, agent.temperature, agent.enabled, agent.schedule_interval, promptTemplateId]);

      if (promptTemplateId) {
        await pool().query(
          `update agent_configs set prompt_template_id = coalesce(prompt_template_id, $1) where agent_id = $2`,
          [promptTemplateId, agent.agent_id]
        );
      }
    }

    // 初始化默认 Rule 数据
    for (const rule of DEFAULT_RULES) {
      await pool().query(`
        insert into agent_rules (category, assignee_role, normal_deduction, major_deduction)
        values ($1, $2, $3, $4)
        on conflict (category) do nothing
      `, [rule.category, rule.assignee_role, rule.normal_deduction, rule.major_deduction]);
    }

    await pool().query(
      `insert into hr_rating_configs (config_key, config, enabled)
       values ('employee_rating', $1::jsonb, true)
       on conflict (config_key) do nothing`,
      [JSON.stringify(DEFAULT_EMPLOYEE_RATING_CONFIG)]
    );

    await pool().query(
      `insert into hr_rating_configs (config_key, config, enabled)
       values ('ops_agent', $1::jsonb, true)
       on conflict (config_key) do nothing`,
      [JSON.stringify(DEFAULT_OPS_AGENT_CONFIG)]
    );
    
    console.log('[AgentConfig] Tables ensured and default data seeded.');
  } catch (e) {
    console.error('[AgentConfig] Init error:', e);
  }
}

export function registerAgentConfigRoutes(app, authRequired) {
  const assertAdmin = (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) {
      res.status(403).json({ error: 'forbidden' });
      return false;
    }
    return true;
  };

  // === Agent Configs ===
  app.get('/api/admin/agents/configs', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    try {
      const r = await pool().query(`
        select c.*, t.name as prompt_template_name
        from agent_configs c
        left join agent_prompt_templates t on c.prompt_template_id = t.id
        order by c.agent_id
      `);
      res.json({ configs: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/admin/agents/configs/:agent_id', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const agentId = req.params.agent_id;
    const body = req.body || {};
    const { system_prompt, model_name, temperature, enabled, schedule_interval } = body;
    const hasTemplateField = Object.prototype.hasOwnProperty.call(body, 'prompt_template_id');
    const promptTemplateId = hasTemplateField ? String(body.prompt_template_id || '').trim() : null;
    try {
      let nextPrompt = String(system_prompt || '').trim();
      if (hasTemplateField && promptTemplateId) {
        const t = await pool().query(
          `select id, content from agent_prompt_templates where id = $1 and enabled = true limit 1`,
          [promptTemplateId]
        );
        if (!t.rows?.length) return res.status(400).json({ error: 'invalid_prompt_template_id' });
        nextPrompt = String(t.rows[0].content || '').trim();
      }
      const r = await pool().query(`
        update agent_configs
        set system_prompt = $1,
            model_name = $2,
            temperature = $3,
            enabled = $4,
            schedule_interval = $5,
            prompt_template_id = case when $6 then nullif($7, '')::uuid else prompt_template_id end,
            updated_at = now()
        where agent_id = $8 returning *
      `, [nextPrompt, model_name, temperature, enabled, schedule_interval, hasTemplateField, promptTemplateId, agentId]);
      clearAgentConfigCache();
      res.json({ config: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // === Prompt Templates ===
  app.get('/api/admin/agents/templates', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const agentId = String(req.query?.agent_id || '').trim();
    try {
      if (agentId) {
        const r = await pool().query(
          `select * from agent_prompt_templates where agent_id = $1 order by is_builtin desc, updated_at desc`,
          [agentId]
        );
        return res.json({ templates: r.rows });
      }
      const r = await pool().query('select * from agent_prompt_templates order by agent_id, is_builtin desc, updated_at desc');
      return res.json({ templates: r.rows });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/agents/templates', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const agentId = String(req.body?.agent_id || '').trim();
    const name = String(req.body?.name || '').trim();
    const content = String(req.body?.content || '').trim();
    const enabled = req.body?.enabled !== false;
    if (!agentId || !name || !content) return res.status(400).json({ error: 'missing_params' });
    try {
      const key = `custom_${agentId}_${Date.now()}`;
      const r = await pool().query(
        `insert into agent_prompt_templates (template_key, agent_id, name, content, enabled, is_builtin)
         values ($1, $2, $3, $4, $5, false)
         returning *`,
        [key, agentId, name, content, enabled]
      );
      return res.json({ template: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/agents/templates/:id', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const id = String(req.params?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_id' });
    try {
      const old = await pool().query('select * from agent_prompt_templates where id = $1 limit 1', [id]);
      if (!old.rows?.length) return res.status(404).json({ error: 'not_found' });
      const row = old.rows[0];

      if (row.is_builtin) {
        const enabled2 = req.body?.enabled === undefined ? row.enabled : !!req.body.enabled;
        const name2 = String(req.body?.name || row.name).trim() || row.name;
        const r = await pool().query(
          `update agent_prompt_templates set name = $1, enabled = $2, updated_at = now() where id = $3 returning *`,
          [name2, enabled2, id]
        );
        return res.json({ template: r.rows[0], locked_content: true });
      }

      const name2 = String(req.body?.name || row.name).trim() || row.name;
      const content2 = String(req.body?.content || row.content).trim() || row.content;
      const enabled2 = req.body?.enabled === undefined ? row.enabled : !!req.body.enabled;
      const r = await pool().query(
        `update agent_prompt_templates set name = $1, content = $2, enabled = $3, updated_at = now() where id = $4 returning *`,
        [name2, content2, enabled2, id]
      );
      return res.json({ template: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/admin/agents/templates/:id', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const id = String(req.params?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_id' });
    try {
      const old = await pool().query('select * from agent_prompt_templates where id = $1 limit 1', [id]);
      if (!old.rows?.length) return res.status(404).json({ error: 'not_found' });
      if (old.rows[0].is_builtin) return res.status(400).json({ error: 'builtin_template_cannot_delete' });

      const used = await pool().query('select count(*)::int as c from agent_configs where prompt_template_id = $1', [id]);
      if (Number(used.rows?.[0]?.c || 0) > 0) return res.status(400).json({ error: 'template_in_use' });

      await pool().query('delete from agent_prompt_templates where id = $1', [id]);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // === HR 员工评级模型配置 ===
  app.get('/api/admin/hr/employee-rating-config', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    try {
      const r = await pool().query(`
        select config, enabled, updated_at
        from hr_rating_configs
        where config_key = 'employee_rating'
        limit 1
      `);
      const row = r.rows?.[0];
      const config = row?.config ? toJson(row.config, DEFAULT_EMPLOYEE_RATING_CONFIG) : DEFAULT_EMPLOYEE_RATING_CONFIG;
      return res.json({ config, enabled: row?.enabled !== false, updated_at: row?.updated_at || null });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/hr/employee-rating-config', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const config = req.body?.config;
    const enabled2 = req.body?.enabled !== false;
    if (!validateEmployeeRatingConfig(config)) return res.status(400).json({ error: 'invalid_config' });
    try {
      const r = await pool().query(
        `insert into hr_rating_configs (config_key, config, enabled, updated_at)
         values ('employee_rating', $1::jsonb, $2, now())
         on conflict (config_key)
         do update set config = excluded.config, enabled = excluded.enabled, updated_at = now()
         returning config, enabled, updated_at`,
        [JSON.stringify(config), enabled2]
      );
      clearEmployeeRatingConfigCache();
      return res.json({ ok: true, config: toJson(r.rows?.[0]?.config, config), enabled: r.rows?.[0]?.enabled !== false });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // === OP Agent 配置 ===
  app.get('/api/admin/agents/ops-config', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    try {
      const r = await pool().query(`
        select config, enabled, updated_at
        from hr_rating_configs
        where config_key = 'ops_agent'
        limit 1
      `);
      const row = r.rows?.[0];
      const config = row?.config ? toJson(row.config, DEFAULT_OPS_AGENT_CONFIG) : DEFAULT_OPS_AGENT_CONFIG;
      return res.json({ config, enabled: row?.enabled !== false, updated_at: row?.updated_at || null });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/agents/ops-config', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const config = req.body?.config;
    const enabled2 = req.body?.enabled !== false;
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'invalid_config' });
    try {
      const r = await pool().query(
        `insert into hr_rating_configs (config_key, config, enabled, updated_at)
         values ('ops_agent', $1::jsonb, $2, now())
         on conflict (config_key)
         do update set config = excluded.config, enabled = excluded.enabled, updated_at = now()
         returning config, enabled, updated_at`,
        [JSON.stringify(config), enabled2]
      );
      clearOpsAgentConfigCache();
      return res.json({ config: r.rows[0].config, enabled: r.rows[0].enabled, updated_at: r.rows[0].updated_at });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/agents/rules/:id', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const id = req.params.id;
    const { category, assignee_role, normal_deduction, major_deduction, enabled } = req.body;
    try {
      const r = await pool().query(`
        update agent_rules
        set category = $1, assignee_role = $2, normal_deduction = $3, major_deduction = $4, enabled = $5, updated_at = now()
        where id = $6 returning *
      `, [category, assignee_role, normal_deduction, major_deduction, enabled, id]);
      clearAgentRuleCache();
      res.json({ rule: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/agents/rules', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const { category, assignee_role, normal_deduction, major_deduction, enabled } = req.body;
    try {
      const r = await pool().query(`
        insert into agent_rules (category, assignee_role, normal_deduction, major_deduction, enabled)
        values ($1, $2, $3, $4, $5) returning *
      `, [category, assignee_role, normal_deduction, major_deduction, enabled !== false]);
      clearAgentRuleCache();
      res.json({ rule: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/admin/agents/rules/:id', authRequired, async (req, res) => {
    if (!assertAdmin(req, res)) return;
    const id = req.params.id;
    try {
      await pool().query('delete from agent_rules where id = $1', [id]);
      clearAgentRuleCache();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

// 缓存相关的辅助函数
let cachedRules = null;
let rulesLastFetched = 0;
const CACHE_TTL = 60 * 1000; // 1 分钟缓存

export function clearAgentRuleCache() {
  cachedRules = null;
  rulesLastFetched = 0;
}

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

export function clearAgentConfigCache() {
  cachedConfigs = null;
  configsLastFetched = 0;
}

let opsAgentConfigCache = null;
let opsAgentConfigLastFetch = 0;

export async function getOpsAgentConfig() {
  const now = Date.now();
  if (opsAgentConfigCache && (now - opsAgentConfigLastFetch < 60000)) {
    return opsAgentConfigCache;
  }
  try {
    const r = await pool().query(`select config from hr_rating_configs where config_key = 'ops_agent' and enabled = true limit 1`);
    if (r.rows?.length > 0 && r.rows[0].config) {
      opsAgentConfigCache = toJson(r.rows[0].config, DEFAULT_OPS_AGENT_CONFIG);
    } else {
      opsAgentConfigCache = DEFAULT_OPS_AGENT_CONFIG;
    }
  } catch (e) {
    console.error('[AgentConfig] getOpsAgentConfig error:', e);
    opsAgentConfigCache = DEFAULT_OPS_AGENT_CONFIG;
  }
  opsAgentConfigLastFetch = now;
  return opsAgentConfigCache;
}

export function clearOpsAgentConfigCache() {
  opsAgentConfigCache = null;
  opsAgentConfigLastFetch = 0;
}

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

let cachedEmployeeRatingConfig = null;
let employeeRatingLastFetched = 0;

export function clearEmployeeRatingConfigCache() {
  cachedEmployeeRatingConfig = null;
  employeeRatingLastFetched = 0;
}

export async function getEmployeeRatingConfig() {
  const now = Date.now();
  if (cachedEmployeeRatingConfig && (now - employeeRatingLastFetched < CACHE_TTL)) {
    return cachedEmployeeRatingConfig;
  }
  try {
    const r = await pool().query(`
      select config
      from hr_rating_configs
      where config_key = 'employee_rating' and enabled = true
      limit 1
    `);
    cachedEmployeeRatingConfig = r.rows?.[0]?.config ? toJson(r.rows[0].config, DEFAULT_EMPLOYEE_RATING_CONFIG) : DEFAULT_EMPLOYEE_RATING_CONFIG;
    employeeRatingLastFetched = now;
    return cachedEmployeeRatingConfig;
  } catch (e) {
    console.error('[getEmployeeRatingConfig] Error:', e);
    return DEFAULT_EMPLOYEE_RATING_CONFIG;
  }
}
