create or replace function public.admin_dashboard_activity_feed()
returns jsonb
language sql
security definer
set search_path = public
as $$
with events as (
  select
    created_at,
    action as kind,
    case action
      when 'user_blocked' then 'Usuario bloqueado'
      when 'user_unblocked' then 'Usuario desbloqueado'
    end as title,
    'Cambio administrativo registrado.'::text as detail
  from public.admin_action_audit
  where created_at >= now() - interval '7 days'
  union all
  select
    coalesce(closed_at, created_at) as created_at,
    'batch_completed'::text as kind,
    'Lote finalizado'::text as title,
    format('%s stickers creados, %s fallidos.', processed_count, failed_count) as detail
  from public.batch_sessions
  where status = 'closed'
    and processed_count + failed_count >= received_count
    and coalesce(closed_at, created_at) >= now() - interval '7 days'
), recent as (
  select * from events order by created_at desc limit 10
)
select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'created_at', created_at,
      'kind', kind,
      'title', title,
      'detail', detail
    ) order by created_at desc
  ),
  '[]'::jsonb
)
from recent;
$$;

revoke all on function public.admin_dashboard_activity_feed() from public, anon, authenticated;
grant execute on function public.admin_dashboard_activity_feed() to service_role;
