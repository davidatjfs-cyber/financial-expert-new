-- Investigate table_visit week count mismatch and table sync stats
select 'exact_hc_jg_0216_0222' as tag, count(*) as cnt
from table_visit_records
where store = '洪潮久光店' and date between '2026-02-16' and '2026-02-22';

select 'exact_hc_jg_0217_0223' as tag, count(*) as cnt
from table_visit_records
where store = '洪潮久光店' and date between '2026-02-17' and '2026-02-23';

select 'old_logic_target_洪潮大宁久光店_0217_0223' as tag, count(*) as cnt
from table_visit_records
where (
  lower(regexp_replace(store, '\s+', '', 'g')) = lower(regexp_replace('洪潮大宁久光店', '\s+', '', 'g'))
  or lower(regexp_replace(store, '\s+', '', 'g')) like '%' || lower(regexp_replace('洪潮大宁久光店', '\s+', '', 'g')) || '%'
  or lower(regexp_replace('洪潮大宁久光店', '\s+', '', 'g')) like '%' || lower(regexp_replace(store, '\s+', '', 'g')) || '%'
) and date between '2026-02-17' and '2026-02-23';

select to_char(date,'YYYY-MM-DD') as dt, store, count(*) as cnt
from table_visit_records
where store in ('洪潮久光店','洪潮大宁久光店') and date between '2026-02-16' and '2026-02-23'
group by to_char(date,'YYYY-MM-DD'), store
order by dt, store;

with t(name, table_id) as (
  values
  ('例会报告','tblZXgaU0LpSye2m'),
  ('收档报告','tblXYfSBRrgNGohN'),
  ('开档报告','tbl32E6d0CyvLvfi'),
  ('马己仙原料收货日报','tblz4kW1cY22XRlL'),
  ('洪潮原料收货日报','tbllcV1evqTJyzlN')
)
select t.name, t.table_id, count(f.*)::int as total,
       max(f.updated_at) as latest_sync_time,
       (array_agg(f.record_id order by f.updated_at desc))[1] as latest_record_id
from t
left join feishu_generic_records f on f.table_id = t.table_id
group by t.name, t.table_id
order by t.name;
