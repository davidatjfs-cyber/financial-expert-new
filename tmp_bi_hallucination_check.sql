\pset pager off

-- 最近BI输出里含“卤鹅”
select created_at, sender_username, sender_name, routed_to, content_type,
       left(content, 300) as content_preview,
       agent_data
from agent_messages
where direction='out'
  and routed_to='data_auditor'
  and content ilike '%卤鹅%'
order by created_at desc
limit 20;

-- 最近用户问“昨天/桌访/差评”及对应BI回复
with in_msgs as (
  select id, created_at, sender_username, content
  from agent_messages
  where direction='in'
    and content_type='text'
    and (content ilike '%昨天%' or content ilike '%桌访%' or content ilike '%差评%')
  order by created_at desc
  limit 30
)
select i.created_at as user_time,
       i.sender_username,
       i.content as user_q,
       o.created_at as bi_time,
       left(o.content, 300) as bi_reply,
       o.agent_data
from in_msgs i
left join lateral (
  select *
  from agent_messages o
  where o.direction='out'
    and o.sender_username=i.sender_username
    and o.created_at >= i.created_at
  order by o.created_at asc
  limit 1
) o on true
order by i.created_at desc;
