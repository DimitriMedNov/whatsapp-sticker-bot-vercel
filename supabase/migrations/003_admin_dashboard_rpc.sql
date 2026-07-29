create or replace function public.admin_mask_phone(p_phone text)
returns text
language sql
immutable
as $$
  select repeat('*', greatest(length(p_phone) - 4, 8)) || right(p_phone, 4);
$$;

create or replace function public.admin_dashboard_metrics(
  p_status text default null,
  p_processing_type text default null,
  p_phone_suffix text default null,
  p_period text default '24h'
)
returns jsonb
language sql
security definer
set search_path = public
as $$
with filtered as (
  select * from public.processing_events
  where (p_status is null or status = p_status)
    and (p_processing_type is null or processing_type = p_processing_type)
    and (p_phone_suffix is null or right(phone, 4) = p_phone_suffix)
    and created_at >= case p_period when 'today' then current_date when '7d' then now() - interval '7 days' else now() - interval '24 hours' end
), recent as (
  select * from filtered where created_at >= now() - interval '24 hours'
), finished as (
  select * from recent where status in ('success', 'error')
), daily as (
  select day::date as day,
    (select count(*) from filtered e where e.status = 'success' and e.created_at >= day and e.created_at < day + interval '1 day') as success,
    (select count(*) from filtered e where e.status = 'error' and e.created_at >= day and e.created_at < day + interval '1 day') as error
  from generate_series(current_date - interval '6 days', current_date, interval '1 day') day
), activity as (
  select jsonb_agg(jsonb_build_object(
    'created_at', created_at,
    'phone', public.admin_mask_phone(phone),
    'processing_type', processing_type,
    'status', status,
    'input_bytes', input_bytes,
    'output_bytes', output_bytes,
    'duration_ms', duration_ms,
    'error_summary', left(coalesce(error_message, error_code, ''), 120)
  ) order by created_at desc) as rows from (select * from filtered order by created_at desc limit 100) e
), system_data as (
  select max(created_at) as last_event,
    max(created_at) filter (where status = 'error') as last_error
  from public.processing_events
)
select jsonb_build_object(
  'cards', jsonb_build_object(
    'stickers_today', (select count(*) from filtered where status = 'success' and created_at >= current_date),
    'stickers_24h', (select count(*) from recent where status = 'success'),
    'active_users_24h', (select count(distinct phone) from recent),
    'open_batches', (select count(*) from public.batch_sessions where status = 'open'),
    'errors_24h', (select count(*) from recent where status = 'error'),
    'success_rate', coalesce(round((select count(*)::numeric from finished where status = 'success') * 100 / nullif((select count(*) from finished), 0), 1), 0),
    'average_duration_ms', coalesce(round((select avg(duration_ms) from finished where duration_ms is not null), 0), 0),
    'average_output_bytes', coalesce(round((select avg(output_bytes) from finished where output_bytes is not null and status = 'success'), 0), 0)
  ),
  'daily', coalesce((select jsonb_agg(to_jsonb(d) order by day) from daily d), '[]'::jsonb),
  'activity', coalesce((select rows from activity), '[]'::jsonb),
  'system', jsonb_build_object(
    'last_event_at', (select last_event from system_data),
    'last_error_at', (select last_error from system_data),
    'last_error_summary', (select left(coalesce(error_message, error_code, ''), 120) from public.processing_events where status = 'error' order by created_at desc limit 1)
  )
);
$$;

create or replace function public.admin_dashboard_users(
  p_page integer default 1,
  p_page_size integer default 25,
  p_phone_suffix text default null
)
returns jsonb
language sql
security definer
set search_path = public
as $$
with selected as (
  select u.*, count(e.id) filter (where e.status = 'success') as stickers_total,
    count(e.id) filter (where e.status = 'success' and e.created_at >= now() - interval '1 hour') as stickers_last_hour
  from public.bot_users u
  left join public.processing_events e on e.phone = u.phone
  where p_phone_suffix is null or right(u.phone, 4) = p_phone_suffix
  group by u.phone
), counted as (select count(*) as total from selected)
select jsonb_build_object(
  'total', (select total from counted),
  'page', greatest(p_page, 1),
  'page_size', least(greatest(p_page_size, 1), 100),
  'users', coalesce((select jsonb_agg(jsonb_build_object(
    'phone', public.admin_mask_phone(phone), 'phone_value', phone,
    'created_at', created_at, 'last_activity_at', last_seen_at,
    'stickers_total', stickers_total, 'stickers_last_hour', stickers_last_hour,
    'blocked', blocked
  ) order by last_seen_at desc)
  from selected offset (greatest(p_page, 1) - 1) * least(greatest(p_page_size, 1), 100) limit least(greatest(p_page_size, 1), 100)), '[]'::jsonb)
);
$$;

create or replace function public.admin_dashboard_batches(
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language sql
security definer
set search_path = public
as $$
select jsonb_build_object(
  'page', greatest(p_page, 1),
  'page_size', least(greatest(p_page_size, 1), 100),
  'batches', coalesce((select jsonb_agg(jsonb_build_object(
    'phone', public.admin_mask_phone(phone), 'status', status,
    'received_count', received_count, 'processed_count', processed_count,
    'failed_count', failed_count, 'created_at', created_at,
    'expires_at', expires_at, 'closed_at', closed_at
  ) order by created_at desc)
  from public.batch_sessions offset (greatest(p_page, 1) - 1) * least(greatest(p_page_size, 1), 100) limit least(greatest(p_page_size, 1), 100)), '[]'::jsonb)
);
$$;

create or replace function public.admin_set_user_blocked(p_phone text, p_blocked boolean)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.bot_users set blocked = p_blocked where phone = p_phone returning true;
$$;

revoke all on function public.admin_mask_phone(text) from public, anon, authenticated;
revoke all on function public.admin_dashboard_metrics(text, text, text, text) from public, anon, authenticated;
revoke all on function public.admin_dashboard_users(integer, integer, text) from public, anon, authenticated;
revoke all on function public.admin_dashboard_batches(integer, integer) from public, anon, authenticated;
revoke all on function public.admin_set_user_blocked(text, boolean) from public, anon, authenticated;
grant execute on function public.admin_dashboard_metrics(text, text, text, text) to service_role;
grant execute on function public.admin_dashboard_users(integer, integer, text) to service_role;
grant execute on function public.admin_dashboard_batches(integer, integer) to service_role;
grant execute on function public.admin_set_user_blocked(text, boolean) to service_role;
