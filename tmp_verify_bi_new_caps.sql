\pset pager off

-- 1) verify KPI radar JSON rows recently generated (if any issue created)
select count(*)::bigint as radar_rows_24h,
       max(created_at) as latest_radar_time
from agent_messages
where content_type = 'kpi_radar_alert'
  and created_at > now() - interval '24 hours';

-- 2) deterministic source coverage sanity
select content_type, count(*)::bigint as c, max(created_at) as latest
from agent_messages
where content_type in ('opening_report','closing_report','meeting_report','material_report','negative_review')
group by content_type
order by content_type;
