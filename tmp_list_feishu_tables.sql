select table_name
from information_schema.tables
where table_schema='public'
  and table_name ilike '%feishu%'
order by 1;

select table_name
from information_schema.tables
where table_schema='public'
  and table_name ilike '%sync%'
order by 1;
