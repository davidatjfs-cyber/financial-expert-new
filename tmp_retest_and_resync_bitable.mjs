import { getBitableRecords, pollBitableSubmissions } from './hr-management-system/server/agents.js';
import { pool } from './hr-management-system/server/utils/database.js';

const TARGET_KEYS = [
  'table_visit',
  'bad_reviews',
  'closing_reports',
  'opening_reports',
  'meeting_reports',
  'material_majixian',
  'material_hongchao'
];

async function retestSources() {
  const sourceStats = [];
  for (const key of TARGET_KEYS) {
    const r = await getBitableRecords(key, { pageSize: 1 });
    if (!r?.ok) {
      sourceStats.push({ key, ok: false, error: r?.error || 'unknown_error' });
      continue;
    }
    const first = r.records?.[0] || null;
    sourceStats.push({
      key,
      ok: true,
      total: Number(r.total || 0),
      latest_record_id: first?.record_id || null,
      latest_created_time: first?.created_time || null,
      latest_last_modified_time: first?.last_modified_time || null
    });
  }
  return sourceStats;
}

async function forceResync() {
  for (const key of TARGET_KEYS) {
    await pollBitableSubmissions(key);
  }
}

async function fetchDbStats() {
  const db = {};

  const tv = await pool().query(`
    select count(*)::bigint as total_records,
           max(updated_at) as latest_updated_at,
           max(created_at) as latest_created_at,
           max(date) as latest_business_date
    from table_visit_records
  `);
  db.table_visit = tv.rows?.[0] || {};

  const typeMap = {
    bad_reviews: 'bad_review',
    closing_reports: 'closing_report',
    opening_reports: 'opening_report',
    meeting_reports: 'meeting_report',
    material_majixian: 'material_report',
    material_hongchao: 'material_report'
  };

  for (const key of Object.keys(typeMap)) {
    if (key === 'material_majixian') {
      const r = await pool().query(`
        select count(distinct record_id)::bigint as total_records,
               max(updated_at) as latest_updated_at,
               max(created_at) as latest_created_at
        from agent_messages
        where content_type = 'material_report'
          and coalesce(agent_data->>'brand','') = 'majixian'
      `);
      db[key] = r.rows?.[0] || {};
      continue;
    }
    if (key === 'material_hongchao') {
      const r = await pool().query(`
        select count(distinct record_id)::bigint as total_records,
               max(updated_at) as latest_updated_at,
               max(created_at) as latest_created_at
        from agent_messages
        where content_type = 'material_report'
          and coalesce(agent_data->>'brand','') = 'hongchao'
      `);
      db[key] = r.rows?.[0] || {};
      continue;
    }

    const r = await pool().query(`
      select count(distinct record_id)::bigint as total_records,
             max(updated_at) as latest_updated_at,
             max(created_at) as latest_created_at
      from agent_messages
      where content_type = $1
    `, [typeMap[key]]);
    db[key] = r.rows?.[0] || {};
  }

  const generic = await pool().query(`
    select table_id,
           count(*)::bigint as total_records,
           max(updated_at) as latest_updated_at,
           max(created_at) as latest_created_at
    from feishu_generic_records
    where table_id in (
      'tblpx5Efqc6eHo3L',
      'tblgReexNjWJOJB6',
      'tblXYfSBRrgNGohN',
      'tbl32E6d0CyvLvfi',
      'tblZXgaU0LpSye2m',
      'tblz4kW1cY22XRlL',
      'tbllcV1evqTJyzlN'
    )
    group by table_id
    order by table_id
  `);
  db.feishu_generic_records = generic.rows || [];

  return db;
}

(async () => {
  try {
    const sourceStats = await retestSources();
    await forceResync();
    const dbStats = await fetchDbStats();
    console.log(JSON.stringify({ ok: true, sourceStats, dbStats }, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2));
    process.exit(1);
  }
})();
