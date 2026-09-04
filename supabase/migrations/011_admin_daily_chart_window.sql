-- 011: la gráfica de siete días deja de recortarse con el filtro de periodo.
-- `daily` pasa a leer de `weekly`, con ventana fija de 7 días y los mismos
-- filtros de estado, tipo y teléfono que el resto del panel.
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
with bounds as (
  select case p_period
    when 'today' then date_trunc('day', now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City'
    when '7d' then now() - interval '7 days'
    else now() - interval '24 hours'
  end as current_start,
  now() as current_end
), comparison_bounds as (
  select current_start, current_end,
    current_start - (current_end - current_start) as previous_start
  from bounds
), filtered as (
  select e.* from public.processing_events e cross join comparison_bounds b
  where (p_status is null or e.status = p_status)
    and (p_processing_type is null or e.processing_type = p_processing_type)
    and (p_phone_suffix is null or right(e.phone, 4) = p_phone_suffix)
    and e.created_at >= b.current_start
), recent as (
  select * from filtered where created_at >= now() - interval '24 hours'
), finished as (
  select * from recent where status in ('success', 'error')
), weekly as (
  select e.* from public.processing_events e
  where (p_status is null or e.status = p_status)
    and (p_processing_type is null or e.processing_type = p_processing_type)
    and (p_phone_suffix is null or right(e.phone, 4) = p_phone_suffix)
    and e.created_at >= current_date - interval '6 days'
), daily as (
  select day::date as day,
    (select count(*) from weekly e where e.status = 'success' and e.created_at >= day and e.created_at < day + interval '1 day') as success,
    (select count(*) from weekly e where e.status = 'error' and e.created_at >= day and e.created_at < day + interval '1 day') as error
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
), queue_data as (
  select
    count(*) filter (where status = 'accepted') as waiting,
    count(*) filter (where status = 'processing') as processing,
    count(*) filter (where status = 'error' and created_at >= now() - interval '24 hours') as failed_24h
  from public.processing_events
), comparison as (
  select
    count(*) filter (where e.status = 'success' and e.created_at >= b.current_start and e.created_at < b.current_end) as current_success,
    count(*) filter (where e.status = 'success' and e.created_at >= b.previous_start and e.created_at < b.current_start) as previous_success,
    count(*) filter (where e.status in ('success', 'error') and e.created_at >= b.current_start and e.created_at < b.current_end) as current_finished,
    count(*) filter (where e.status in ('success', 'error') and e.created_at >= b.previous_start and e.created_at < b.current_start) as previous_finished
  from public.processing_events e cross join comparison_bounds b
  where (p_status is null or e.status = p_status)
    and (p_processing_type is null or e.processing_type = p_processing_type)
    and (p_phone_suffix is null or right(e.phone, 4) = p_phone_suffix)
    and e.created_at >= b.previous_start
), peak_hours as (
  select extract(hour from created_at at time zone 'America/Mexico_City')::integer as hour, count(*) as total
  from public.processing_events
  where created_at >= now() - interval '7 days'
  group by 1
  order by total desc, hour asc
  limit 3
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
  'queue', jsonb_build_object(
    'waiting', coalesce((select waiting from queue_data), 0),
    'processing', coalesce((select processing from queue_data), 0),
    'failed_24h', coalesce((select failed_24h from queue_data), 0)
  ),
  'trends', jsonb_build_object(
    'processed_current', coalesce((select current_success from comparison), 0),
    'processed_previous', coalesce((select previous_success from comparison), 0),
    'processed_change_percent', (select round((current_success - previous_success) * 100.0 / nullif(previous_success, 0), 1) from comparison),
    'success_rate_current', coalesce((select round(current_success * 100.0 / nullif(current_finished, 0), 1) from comparison), 0),
    'success_rate_previous', coalesce((select round(previous_success * 100.0 / nullif(previous_finished, 0), 1) from comparison), 0),
    'success_rate_change_points', (select round((current_success * 100.0 / nullif(current_finished, 0)) - (previous_success * 100.0 / nullif(previous_finished, 0)), 1) from comparison)
  ),
  'peak_hours', coalesce((select jsonb_agg(jsonb_build_object('hour', hour, 'total', total) order by total desc, hour asc) from peak_hours), '[]'::jsonb),
  'daily', coalesce((select jsonb_agg(to_jsonb(d) order by day) from daily d), '[]'::jsonb),
  'activity', coalesce((select rows from activity), '[]'::jsonb),
  'system', jsonb_build_object(
    'last_event_at', (select last_event from system_data),
    'last_error_at', (select last_error from system_data),
    'last_error_summary', (select left(coalesce(error_message, error_code, ''), 120) from public.processing_events where status = 'error' order by created_at desc limit 1)
  )
);
$$;

revoke all on function public.admin_dashboard_metrics(text, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_dashboard_metrics(text, text, text, text) to service_role;
