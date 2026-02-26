\pset pager off

-- 1) structured table: table_visit_records
select 'table_visit_records' as source,
       count(*)::bigint as total_records,
       max(created_at) as latest_created_at,
       max(updated_at) as latest_updated_at,
       max(date) as latest_business_date
from table_visit_records;

-- 2) raw sync table: feishu_generic_records (if table_visit data lands here)
select 'feishu_generic_records(table_visit%)' as source,
       count(*)::bigint as total_records,
       max(created_at) as latest_created_at,
       max(updated_at) as latest_updated_at
from feishu_generic_records
where source_key ilike 'table_visit%';

-- 3) latest 3 rows in structured table for quick audit
select id, record_id, date, store, created_at, updated_at
from table_visit_records
order by coalesce(updated_at, created_at) desc nulls last
limit 3;
