-- 1) Current agent prompts in DB
select agent_id,
       name,
       enabled,
       model_name,
       temperature,
       schedule_interval,
       prompt_template_id,
       left(system_prompt, 500) as system_prompt,
       updated_at
from agent_configs
order by agent_id;

-- 2) Prompt templates per agent
select agent_id,
       count(*)::int as template_count,
       count(*) filter (where enabled = true)::int as enabled_template_count,
       max(updated_at) as latest_template_update
from agent_prompt_templates
group by agent_id
order by agent_id;

-- 3) Runtime data synced into agent_messages for the 5 target tables (by content_type)
select content_type,
       count(*)::int as total,
       max(updated_at) as latest_updated_at
from agent_messages
where content_type in ('meeting_report','closing_report','opening_report','material_report')
group by content_type
order by content_type;

-- 4) Latest record snapshot for each content_type
with ranked as (
  select content_type,
         record_id,
         updated_at,
         row_number() over(partition by content_type order by updated_at desc nulls last) as rn
  from agent_messages
  where content_type in ('meeting_report','closing_report','opening_report','material_report')
)
select content_type, record_id, updated_at
from ranked
where rn = 1
order by content_type;

-- 5) Generic record cache status for 5 table IDs
with t(name, table_id) as (
  values
  ('例会报告','tblZXgaU0LpSye2m'),
  ('收档报告','tblXYfSBRrgNGohN'),
  ('开档报告','tbl32E6d0CyvLvfi'),
  ('马己仙原料收货日报','tblz4kW1cY22XRlL'),
  ('洪潮原料收货日报','tbllcV1evqTJyzlN')
)
select t.name,
       t.table_id,
       count(f.*)::int as total,
       max(f.updated_at) as latest_sync_time,
       (array_agg(f.record_id order by f.updated_at desc))[1] as latest_record_id
from t
left join feishu_generic_records f on f.table_id = t.table_id
group by t.name, t.table_id
order by t.name;
