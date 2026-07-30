create or replace function public.admin_dashboard_alerts()
returns jsonb
language sql
security definer
set search_path = public
as $$
with error_window as (
  select
    count(*) filter (where created_at >= now() - interval '1 hour') as current_errors,
    count(*) filter (where created_at >= now() - interval '2 hours' and created_at < now() - interval '1 hour') as previous_errors
  from public.processing_events
  where status = 'error'
), success_window as (
  select
    count(*) filter (where status = 'success') as successes,
    count(*) filter (where status in ('success', 'error')) as finished
  from public.processing_events
  where created_at >= now() - interval '24 hours'
), batch_window as (
  select
    count(*) filter (where failed_count > 0) as failed_batches,
    coalesce(sum(failed_count) filter (where failed_count > 0), 0) as failed_items
  from public.batch_sessions
  where created_at >= now() - interval '24 hours'
), alerts as (
  select 'critical'::text as severity,
    'Pico de errores'::text as title,
    format('%s errores en la última hora; la hora anterior tuvo %s.', current_errors, previous_errors) as message,
    1 as priority
  from error_window
  where current_errors >= 3 and current_errors >= greatest(previous_errors * 2, 3)
  union all
  select 'warning',
    'Tasa de éxito baja',
    format('La tasa de éxito de las últimas 24 horas es %s%% en %s procesos finalizados.', round(successes * 100.0 / nullif(finished, 0), 1), finished),
    2
  from success_window
  where finished >= 10 and successes * 100.0 / nullif(finished, 0) < 85
  union all
  select 'warning',
    'Lotes con fallos',
    format('%s lote(s) acumulan %s fallo(s) en las últimas 24 horas.', failed_batches, failed_items),
    3
  from batch_window
  where failed_batches > 0
)
select coalesce(
  jsonb_agg(jsonb_build_object('severity', severity, 'title', title, 'message', message) order by priority),
  '[]'::jsonb
)
from alerts;
$$;

revoke all on function public.admin_dashboard_alerts() from public, anon, authenticated;
grant execute on function public.admin_dashboard_alerts() to service_role;
