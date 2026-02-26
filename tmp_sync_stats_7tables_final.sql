\pset pager off

-- 7张表最终口径：结构化入库统计（业务查询实际使用）
select '桌访表(table_visit_records)' as source,
       count(*)::bigint as total_records,
       max(updated_at) as latest_updated_at,
       max(created_at) as latest_created_at
from table_visit_records
union all
select '差评报告(agent_messages:negative_review)' as source,
       count(distinct record_id)::bigint as total_records,
       max(updated_at) as latest_updated_at,
       max(created_at) as latest_created_at
from agent_messages where content_type='negative_review'
union all
select '收档报告(agent_messages:closing_report)' as source,
       count(distinct record_id)::bigint as total_records,
       max(updated_at) as latest_updated_at,
       max(created_at) as latest_created_at
from agent_messages where content_type='closing_report'
union all
select '开档报告(agent_messages:opening_report)' as source,
       count(distinct record_id)::bigint as total_records,
       max(updated_at) as latest_updated_at,
       max(created_at) as latest_created_at
from agent_messages where content_type='opening_report'
union all
select '例会报告(agent_messages:meeting_report)' as source,
       count(distinct record_id)::bigint as total_records,
       max(updated_at) as latest_updated_at,
       max(created_at) as latest_created_at
from agent_messages where content_type='meeting_report'
union all
select '马己仙原料收货日报(agent_messages:material_report:majixian)' as source,
       count(distinct record_id)::bigint as total_records,
       max(updated_at) as latest_updated_at,
       max(created_at) as latest_created_at
from agent_messages
where content_type='material_report'
  and coalesce(agent_data->>'brand','')='majixian'
union all
select '洪潮原料收货日报(agent_messages:material_report:hongchao)' as source,
       count(distinct record_id)::bigint as total_records,
       max(updated_at) as latest_updated_at,
       max(created_at) as latest_created_at
from agent_messages
where content_type='material_report'
  and coalesce(agent_data->>'brand','')='hongchao'
;
