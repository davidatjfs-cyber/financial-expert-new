\pset pager off

select column_name
from information_schema.columns
where table_schema='public' and table_name='feishu_generic_records'
order by ordinal_position;

select column_name
from information_schema.columns
where table_schema='public' and table_name='table_visit_records'
order by ordinal_position;

select id, date, store, created_at, updated_at
from table_visit_records
order by coalesce(updated_at, created_at) desc nulls last
limit 3;

select count(*)::bigint as total_records,
       max(created_at) as latest_created_at,
       max(updated_at) as latest_updated_at
from feishu_generic_records
where source_table = 'table_visit';
