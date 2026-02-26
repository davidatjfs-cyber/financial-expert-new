\pset pager off

-- 1) 桌访结构化表
select 'table_visit_records' as source,
       count(*)::bigint as total_records,
       max(updated_at) as latest_updated_at,
       max(created_at) as latest_created_at,
       max(date) as latest_business_date
from table_visit_records;

-- 2) 其余6张表在 agent_messages 的结构化入库统计
with base as (
  select content_type, record_id, created_at, updated_at, agent_data
  from agent_messages
  where content_type in ('bad_review', 'closing_report', 'opening_report', 'meeting_report', 'material_report')
)
select 'bad_review' as source,
       count(distinct record_id)::bigint as total_records,
       max(updated_at) as latest_updated_at,
       max(created_at) as latest_created_at
from base where content_type = 'bad_review'
union all
select 'closing_report' as source,
       count(distinct record_id)::bigint as total_records,
       max(updated_at) as latest_updated_at,
       max(created_at) as latest_created_at
from base where content_type = 'closing_report'
union all
select 'opening_report' as source,
       count(distinct record_id)::bigint as total_records,
       max(updated_at) as latest_updated_at,
       max(created_at) as latest_created_at
from base where content_type = 'opening_report'
union all
select 'meeting_report' as source,
       count(distinct record_id)::bigint as total_records,
       max(updated_at) as latest_updated_at,
       max(created_at) as latest_created_at
from base where content_type = 'meeting_report'
union all
select 'material_report:majixian' as source,
       count(distinct record_id)::bigint as total_records,
       max(updated_at) as latest_updated_at,
       max(created_at) as latest_created_at
from base where content_type = 'material_report' and coalesce(agent_data->>'brand','') = 'majixian'
union all
select 'material_report:hongchao' as source,
       count(distinct record_id)::bigint as total_records,
       max(updated_at) as latest_updated_at,
       max(created_at) as latest_created_at
from base where content_type = 'material_report' and coalesce(agent_data->>'brand','') = 'hongchao';

-- 3) 原始落库 feishu_generic_records（按7张 table_id）
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
order by table_id;
