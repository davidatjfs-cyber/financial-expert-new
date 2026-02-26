// ─────────────────────────────────────────────────────────────────
// Knowledge Graph Engine — 动态业务实体关系图谱
// ─────────────────────────────────────────────────────────────────
//
// 在现有 PostgreSQL 上构建轻量级知识图谱：
//   1. business_entity_relations 表存储实体间连线
//   2. 确定性规则从 Bitable 数据中抽取实体关系（零 LLM 成本）
//   3. 图谱查询工具供 HQ Brain 使用（递归追溯因果链）
//
// 实体类型: store, dish, material, employee, complaint, anomaly, metric
// 关系类型: BELONGS_TO, USES_MATERIAL, HAS_COMPLAINT, CAUSES, SCORED_BY,
//           MANAGED_BY, ANOMALY_AT, MATERIAL_ISSUE, REVIEW_ABOUT
// ─────────────────────────────────────────────────────────────────

import { pool as getUnifiedPool } from './utils/database.js';

let _pool = null;
export function setKGPool(p) { _pool = p; }
function pool() {
  if (_pool) return _pool;
  return getUnifiedPool();
}

// ─────────────────────────────────────────────
// 1. Database Schema
// ─────────────────────────────────────────────

export async function ensureKnowledgeGraphTables() {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');

    // 核心: 实体关系表
    await client.query(`
      CREATE TABLE IF NOT EXISTS business_entity_relations (
        id SERIAL PRIMARY KEY,
        source_type VARCHAR(50) NOT NULL,
        source_id VARCHAR(300) NOT NULL,
        source_label VARCHAR(300),
        target_type VARCHAR(50) NOT NULL,
        target_id VARCHAR(300) NOT NULL,
        target_label VARCHAR(300),
        relation VARCHAR(100) NOT NULL,
        weight REAL DEFAULT 1.0,
        metadata JSONB DEFAULT '{}',
        date DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_ber_source ON business_entity_relations(source_type, source_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ber_target ON business_entity_relations(target_type, target_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ber_relation ON business_entity_relations(relation)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ber_date ON business_entity_relations(date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ber_composite ON business_entity_relations(source_type, source_id, target_type, target_id, relation, date)`);

    // 实体健康度快照（每日更新）
    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_health_snapshot (
        id SERIAL PRIMARY KEY,
        entity_type VARCHAR(50) NOT NULL,
        entity_id VARCHAR(300) NOT NULL,
        entity_label VARCHAR(300),
        health_score REAL DEFAULT 100,
        dimensions JSONB DEFAULT '{}',
        snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_entity_health_day UNIQUE (entity_type, entity_id, snapshot_date)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ehs_entity ON entity_health_snapshot(entity_type, entity_id, snapshot_date DESC)`);

    // 行动计划表（Phase 3 使用）
    await client.query(`
      CREATE TABLE IF NOT EXISTS action_plans (
        id SERIAL PRIMARY KEY,
        plan_id VARCHAR(60) UNIQUE NOT NULL,
        title VARCHAR(500) NOT NULL,
        goal TEXT,
        store VARCHAR(200),
        brand VARCHAR(120),
        target_role VARCHAR(60),
        status VARCHAR(50) DEFAULT 'draft',
        plan_data JSONB DEFAULT '{}',
        compliance_result JSONB DEFAULT '{}',
        graph_context JSONB DEFAULT '{}',
        approval_id VARCHAR(100),
        created_by VARCHAR(100),
        approved_by VARCHAR(100),
        executed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ap_status ON action_plans(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ap_store ON action_plans(store, status)`);

    await client.query('COMMIT');
    console.log('[knowledge-graph] Tables ensured');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (String(e?.code) === '23505') return; // duplicate
    console.error('[knowledge-graph] ensureTables failed:', e?.message);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────
// 2. Relation Write Helpers
// ─────────────────────────────────────────────

async function upsertRelation({ sourceType, sourceId, sourceLabel, targetType, targetId, targetLabel, relation, weight, metadata, date }) {
  try {
    await pool().query(
      `INSERT INTO business_entity_relations
         (source_type, source_id, source_label, target_type, target_id, target_label, relation, weight, metadata, date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       ON CONFLICT ON CONSTRAINT business_entity_relations_pkey DO NOTHING`,
      [sourceType, sourceId, sourceLabel || sourceId, targetType, targetId, targetLabel || targetId,
       relation, weight || 1.0, JSON.stringify(metadata || {}), date || new Date().toISOString().slice(0, 10)]
    );
  } catch (e) {
    // 尝试去重 insert (composite uniqueness via date+relation+source+target)
    try {
      const exists = await pool().query(
        `SELECT id FROM business_entity_relations
         WHERE source_type=$1 AND source_id=$2 AND target_type=$3 AND target_id=$4 AND relation=$5 AND date=$6 LIMIT 1`,
        [sourceType, sourceId, targetType, targetId, relation, date || new Date().toISOString().slice(0, 10)]
      );
      if (exists.rows?.length) {
        await pool().query(
          `UPDATE business_entity_relations SET weight=$1, metadata=$2::jsonb, updated_at=NOW() WHERE id=$3`,
          [weight || 1.0, JSON.stringify(metadata || {}), exists.rows[0].id]
        );
      } else {
        throw e;
      }
    } catch (e2) {
      console.error('[knowledge-graph] upsertRelation failed:', e2?.message);
    }
  }
}

// ─────────────────────────────────────────────
// 3. Deterministic Entity Extraction Rules
// ─────────────────────────────────────────────
// 零 LLM 成本：从 Bitable 结构化字段直接提取实体和关系

// 3a. 原料异常 → 关系: [原料] --MATERIAL_ISSUE--> [门店], [原料] --CAUSES--> [菜品](if inferable)
export async function extractMaterialRelations(record, configKey) {
  if (!configKey?.startsWith('material_')) return;
  const fields = record?.fields || {};
  const store = String(fields['所属门店'] || fields['门店'] || '').trim();
  if (!store) return;

  const materialName = String(fields['异常原料名称'] || fields['原料名称'] || '').trim();
  const severity = String(fields['严重情况'] || fields['严重程度'] || '').trim();
  const date = parseBitableDate(fields['收货日期'] || fields['日期']);

  if (!materialName) return;

  const weight = severity.includes('严重') ? 3.0 : severity.includes('一般') ? 1.5 : 1.0;

  // 原料 --MATERIAL_ISSUE--> 门店
  await upsertRelation({
    sourceType: 'material', sourceId: materialName, sourceLabel: materialName,
    targetType: 'store', targetId: store, targetLabel: store,
    relation: 'MATERIAL_ISSUE', weight, date,
    metadata: { severity, configKey, rawProcessResult: String(fields['处理结果'] || '').slice(0, 200) }
  });

  // 原料 --BELONGS_TO--> 品牌(infer from store)
  const brand = inferBrand(store);
  if (brand) {
    await upsertRelation({
      sourceType: 'material', sourceId: materialName,
      targetType: 'brand', targetId: brand, targetLabel: brand,
      relation: 'BELONGS_TO', weight: 1.0, date
    });
  }
}

// 3b. 差评 → 关系: [菜品/服务项] --HAS_COMPLAINT--> [门店]
export async function extractBadReviewRelations(record, configKey) {
  if (configKey !== 'bad_reviews') return;
  const fields = record?.fields || {};
  const store = String(fields['门店'] || fields['所属门店'] || '').trim();
  if (!store) return;

  const date = parseBitableDate(fields['日期'] || fields['时间']);

  // 提取差评涉及的菜品名
  const dishName = String(fields['不满意菜品'] || fields['涉及菜品'] || fields['产品名称'] || '').trim();
  const reviewType = String(fields['类型'] || fields['差评类型'] || '').trim();
  const content = String(fields['内容'] || fields['差评内容'] || fields['评价内容'] || '').trim();

  if (dishName) {
    await upsertRelation({
      sourceType: 'dish', sourceId: dishName, sourceLabel: dishName,
      targetType: 'store', targetId: store, targetLabel: store,
      relation: 'HAS_COMPLAINT', weight: 2.0, date,
      metadata: { reviewType, contentSnippet: content.slice(0, 150) }
    });
  }

  if (reviewType) {
    await upsertRelation({
      sourceType: 'complaint_type', sourceId: reviewType,
      targetType: 'store', targetId: store, targetLabel: store,
      relation: 'COMPLAINT_AT', weight: 1.5, date,
      metadata: { contentSnippet: content.slice(0, 150) }
    });
  }
}

// 3c. 桌访 → 关系: [满意度指标] --SCORED_BY--> [门店]
export async function extractTableVisitRelations(record, configKey) {
  if (configKey !== 'table_visit') return;
  const fields = record?.fields || {};
  const store = String(fields['所属门店'] || fields['门店'] || '').trim();
  if (!store) return;

  const date = parseBitableDate(fields['日期']);
  const dissatisfiedDish = extractTextFromField(fields['今天 不满意菜品'] || fields['今日不满意菜品'] || '');
  const feedback = extractTextFromField(fields['满意或不满意的主要原因是什么？'] || '');

  if (dissatisfiedDish) {
    await upsertRelation({
      sourceType: 'dish', sourceId: dissatisfiedDish,
      targetType: 'store', targetId: store,
      relation: 'DISSATISFIED_AT', weight: 1.5, date,
      metadata: { feedback: feedback?.slice(0, 150) }
    });
  }
}

// 3d. 收档/开档报告 → 关系: [合格状态] --INSPECTION_AT--> [门店]
export async function extractInspectionRelations(record, configKey) {
  if (configKey !== 'closing_reports' && configKey !== 'opening_reports') return;
  const fields = record?.fields || {};
  const store = String(fields['门店'] || '').trim();
  if (!store) return;

  const date = parseBitableDate(fields['提交时间'] || fields['记录日期']);
  const qualified = String(fields['是否合格'] || '').trim();
  const score = parseFloat(fields['档口收档平均得分'] || '0');
  const inspectionType = configKey === 'closing_reports' ? '收档' : '开档';

  await upsertRelation({
    sourceType: 'inspection', sourceId: `${inspectionType}_${store}_${date}`,
    sourceLabel: `${inspectionType}检查`,
    targetType: 'store', targetId: store,
    relation: 'INSPECTION_AT', weight: qualified === '不合格' ? 2.5 : 0.5, date,
    metadata: { inspectionType, qualified, score }
  });
}

// 3e. 异常任务 (master_tasks) → 关系: [异常类型] --ANOMALY_AT--> [门店]
export async function extractAnomalyRelations(task) {
  if (!task?.store || !task?.category) return;
  const date = task.created_at ? new Date(task.created_at).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const weight = task.severity === 'high' ? 3.0 : task.severity === 'medium' ? 2.0 : 1.0;

  await upsertRelation({
    sourceType: 'anomaly', sourceId: task.category, sourceLabel: task.title || task.category,
    targetType: 'store', targetId: task.store,
    relation: 'ANOMALY_AT', weight, date,
    metadata: { severity: task.severity, taskId: task.task_id, detail: String(task.detail || '').slice(0, 200) }
  });
}

// 统一入口：Bitable 记录入库后调用
export async function extractRelationsFromBitableRecord(record, configKey) {
  try {
    await Promise.allSettled([
      extractMaterialRelations(record, configKey),
      extractBadReviewRelations(record, configKey),
      extractTableVisitRelations(record, configKey),
      extractInspectionRelations(record, configKey)
    ]);
  } catch (e) {
    console.error('[knowledge-graph] extractRelations error:', e?.message);
  }
}

// ─────────────────────────────────────────────
// 4. Graph Query Engine (供 HQ Brain 调用)
// ─────────────────────────────────────────────

// 4a. 查询某实体的所有关联（1度）
export async function queryEntityRelations(entityType, entityId, options = {}) {
  const { direction = 'both', limit = 50, daysBack = 30 } = options;
  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString().slice(0, 10);

  let rows = [];
  if (direction === 'outgoing' || direction === 'both') {
    const r = await pool().query(
      `SELECT * FROM business_entity_relations
       WHERE source_type=$1 AND source_id=$2 AND date >= $3::date
       ORDER BY weight DESC, date DESC LIMIT $4`,
      [entityType, entityId, sinceStr, limit]
    );
    rows.push(...(r.rows || []));
  }
  if (direction === 'incoming' || direction === 'both') {
    const r = await pool().query(
      `SELECT * FROM business_entity_relations
       WHERE target_type=$1 AND target_id=$2 AND date >= $3::date
       ORDER BY weight DESC, date DESC LIMIT $4`,
      [entityType, entityId, sinceStr, limit]
    );
    rows.push(...(r.rows || []));
  }
  return rows;
}

// 4b. 递归因果链查询（最多 N 跳）
export async function traceCausalChain(entityType, entityId, maxDepth = 3, daysBack = 30) {
  const visited = new Set();
  const chain = [];
  const queue = [{ type: entityType, id: entityId, depth: 0, path: [] }];

  while (queue.length > 0) {
    const current = queue.shift();
    const key = `${current.type}:${current.id}`;
    if (visited.has(key) || current.depth > maxDepth) continue;
    visited.add(key);

    const relations = await queryEntityRelations(current.type, current.id, {
      direction: 'both', limit: 20, daysBack
    });

    for (const rel of relations) {
      const isSource = rel.source_type === current.type && rel.source_id === current.id;
      const otherType = isSource ? rel.target_type : rel.source_type;
      const otherId = isSource ? rel.target_id : rel.source_id;
      const otherLabel = isSource ? rel.target_label : rel.source_label;
      const otherKey = `${otherType}:${otherId}`;

      chain.push({
        from: { type: current.type, id: current.id },
        relation: rel.relation,
        to: { type: otherType, id: otherId, label: otherLabel },
        weight: rel.weight,
        date: rel.date,
        metadata: rel.metadata
      });

      if (!visited.has(otherKey) && current.depth < maxDepth) {
        queue.push({
          type: otherType, id: otherId,
          depth: current.depth + 1,
          path: [...current.path, { relation: rel.relation, entity: otherKey }]
        });
      }
    }
  }

  return chain;
}

// 4c. 门店健康度概览（聚合图谱数据）
export async function getStoreHealthOverview(store, daysBack = 30) {
  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString().slice(0, 10);

  const [anomalies, complaints, materialIssues, inspections] = await Promise.all([
    pool().query(
      `SELECT source_id as category, COUNT(*) as cnt, AVG(weight) as avg_weight
       FROM business_entity_relations
       WHERE target_type='store' AND target_id=$1 AND relation='ANOMALY_AT' AND date>=$2::date
       GROUP BY source_id ORDER BY cnt DESC`,
      [store, sinceStr]
    ),
    pool().query(
      `SELECT source_id as item, COUNT(*) as cnt, AVG(weight) as avg_weight
       FROM business_entity_relations
       WHERE target_type='store' AND target_id=$1 AND relation IN ('HAS_COMPLAINT','DISSATISFIED_AT') AND date>=$2::date
       GROUP BY source_id ORDER BY cnt DESC`,
      [store, sinceStr]
    ),
    pool().query(
      `SELECT source_id as material, COUNT(*) as cnt, AVG(weight) as avg_weight
       FROM business_entity_relations
       WHERE target_type='store' AND target_id=$1 AND relation='MATERIAL_ISSUE' AND date>=$2::date
       GROUP BY source_id ORDER BY cnt DESC`,
      [store, sinceStr]
    ),
    pool().query(
      `SELECT date, weight, metadata FROM business_entity_relations
       WHERE target_type='store' AND target_id=$1 AND relation='INSPECTION_AT' AND date>=$2::date
       ORDER BY date DESC LIMIT 30`,
      [store, sinceStr]
    )
  ]);

  // 计算综合健康分 (100分制)
  const anomalyDeduct = (anomalies.rows || []).reduce((s, r) => s + Number(r.cnt) * Number(r.avg_weight), 0);
  const complaintDeduct = (complaints.rows || []).reduce((s, r) => s + Number(r.cnt) * 0.5, 0);
  const materialDeduct = (materialIssues.rows || []).reduce((s, r) => s + Number(r.cnt) * Number(r.avg_weight) * 0.3, 0);
  const failedInspections = (inspections.rows || []).filter(r => Number(r.weight) > 1.5).length;
  const inspectionDeduct = failedInspections * 2;
  const healthScore = Math.max(0, Math.min(100, 100 - anomalyDeduct - complaintDeduct - materialDeduct - inspectionDeduct));

  return {
    store,
    period: `${sinceStr} ~ ${new Date().toISOString().slice(0, 10)}`,
    healthScore: Math.round(healthScore * 10) / 10,
    anomalies: (anomalies.rows || []).map(r => ({ category: r.category, count: Number(r.cnt), severity: Number(r.avg_weight) })),
    complaints: (complaints.rows || []).map(r => ({ item: r.item, count: Number(r.cnt) })),
    materialIssues: (materialIssues.rows || []).map(r => ({ material: r.material, count: Number(r.cnt), severity: Number(r.avg_weight) })),
    inspections: {
      total: (inspections.rows || []).length,
      failed: failedInspections,
      recentRecords: (inspections.rows || []).slice(0, 5).map(r => ({
        date: r.date, qualified: Number(r.weight) <= 1.5,
        score: r.metadata?.score
      }))
    }
  };
}

// 4d. 跨门店对比分析
export async function crossStoreComparison(stores, daysBack = 30) {
  const results = {};
  for (const store of stores) {
    results[store] = await getStoreHealthOverview(store, daysBack);
  }
  return results;
}

// 4e. 图谱统计概览（供 Dashboard 使用）
export async function getGraphStats() {
  try {
    const [totalR, typeR, recentR] = await Promise.all([
      pool().query(`SELECT COUNT(*) as total FROM business_entity_relations`),
      pool().query(`SELECT relation, COUNT(*) as cnt FROM business_entity_relations GROUP BY relation ORDER BY cnt DESC`),
      pool().query(`SELECT date, COUNT(*) as cnt FROM business_entity_relations WHERE date >= CURRENT_DATE - 7 GROUP BY date ORDER BY date DESC`)
    ]);
    return {
      totalRelations: Number(totalR.rows?.[0]?.total || 0),
      byRelationType: (typeR.rows || []).map(r => ({ relation: r.relation, count: Number(r.cnt) })),
      last7Days: (recentR.rows || []).map(r => ({ date: r.date, count: Number(r.cnt) }))
    };
  } catch (e) {
    return { totalRelations: 0, byRelationType: [], last7Days: [], error: e?.message };
  }
}

// ─────────────────────────────────────────────
// 5. 实体健康度快照（每日刷新）
// ─────────────────────────────────────────────

export async function refreshEntityHealthSnapshots() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    // 获取所有活跃门店
    const storesR = await pool().query(
      `SELECT DISTINCT target_id as store FROM business_entity_relations WHERE target_type='store' AND date >= CURRENT_DATE - 30`
    );
    let updated = 0;
    for (const row of (storesR.rows || [])) {
      const overview = await getStoreHealthOverview(row.store, 30);
      await pool().query(
        `INSERT INTO entity_health_snapshot (entity_type, entity_id, entity_label, health_score, dimensions, snapshot_date)
         VALUES ('store', $1, $1, $2, $3::jsonb, $4::date)
         ON CONFLICT ON CONSTRAINT uq_entity_health_day DO UPDATE SET
           health_score = EXCLUDED.health_score, dimensions = EXCLUDED.dimensions`,
        [row.store, overview.healthScore, JSON.stringify({
          anomalyCount: overview.anomalies.length,
          complaintCount: overview.complaints.length,
          materialIssueCount: overview.materialIssues.length,
          inspectionFailRate: overview.inspections.total > 0 ? overview.inspections.failed / overview.inspections.total : 0
        }), today]
      );
      updated++;
    }
    console.log(`[knowledge-graph] Refreshed health snapshots for ${updated} stores`);
    return updated;
  } catch (e) {
    console.error('[knowledge-graph] refreshHealthSnapshots error:', e?.message);
    return 0;
  }
}

// ─────────────────────────────────────────────
// 6. Utility
// ─────────────────────────────────────────────

function parseBitableDate(val) {
  if (!val) return new Date().toISOString().slice(0, 10);
  const v = typeof val === 'string' ? val.trim() : val;
  // Unix timestamp in seconds (10 digits) or milliseconds (13 digits)
  if (typeof v === 'number' || /^\d{10,13}$/.test(v)) {
    const n = Number(v);
    const ms = n > 1e12 ? n : n * 1000; // seconds → ms
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  // ISO or YYYY-MM-DD string
  if (typeof v === 'string' && v.length >= 10) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function inferBrand(storeName) {
  const s = String(storeName || '').trim();
  if (s.includes('洪潮')) return '洪潮传统潮汕菜';
  if (s.includes('马己仙')) return '马己仙广东小馆';
  return '';
}

function extractTextFromField(field) {
  if (!field) return '';
  if (typeof field === 'string') return field.trim();
  if (Array.isArray(field)) {
    // Bitable complex field: [{"type":"text","text_arr":["卤鹅"]}]
    return field.map(item => {
      if (typeof item === 'string') return item;
      if (item?.text_arr) return item.text_arr.join('');
      if (item?.text) return item.text;
      return '';
    }).join('').trim();
  }
  if (typeof field === 'object' && field.text_arr) return field.text_arr.join('').trim();
  return String(field).trim();
}

// Format graph query result into human-readable text for LLM context
export function formatGraphContextForLLM(chain, maxLines = 30) {
  if (!chain?.length) return '（图谱中暂无相关关联数据）';
  const lines = [];
  const seen = new Set();
  for (const link of chain) {
    const key = `${link.from.type}:${link.from.id}-${link.relation}-${link.to.type}:${link.to.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const arrow = `[${link.from.type}:${link.from.id}] --${link.relation}(权重${link.weight})--> [${link.to.type}:${link.to.id || link.to.label}]`;
    const dateTag = link.date ? ` (${link.date})` : '';
    lines.push(`${arrow}${dateTag}`);
    if (lines.length >= maxLines) break;
  }
  return lines.join('\n');
}
