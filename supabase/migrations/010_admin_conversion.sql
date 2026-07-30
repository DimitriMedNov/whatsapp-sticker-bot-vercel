create or replace function public.admin_dashboard_conversion(
  p_processing_type text default null,
  p_phone_suffix text default null,
  p_period text default '24h'
)
returns jsonb
language sql
security definer
set search_path = public
as $$
with scoped as (
  select * from public.processing_events
  where (p_processing_type is null or processing_type = p_processing_type)
    and (p_phone_suffix is null or right(phone, 4) = p_phone_suffix)
    and created_at >= case p_period
      when 'today' then date_trunc('day', now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City'
      when '7d' then now() - interval '7 days'
      else now() - interval '24 hours'
    end
), totals as (
  select
    count(*) as received,
    count(*) filter (where status in ('accepted', 'processing', 'success', 'error')) as accepted,
    count(*) filter (where status = 'success') as successful,
    count(*) filter (where status = 'rejected') as rejected,
    count(*) filter (where status = 'error') as failed
  from scoped
)
select jsonb_build_object(
  'received', received,
  'accepted', accepted,
  'successful', successful,
  'rejected', rejected,
  'failed', failed,
  'acceptance_rate', coalesce(round(accepted * 100.0 / nullif(received, 0), 1), 0),
  'success_rate', coalesce(round(successful * 100.0 / nullif(accepted, 0), 1), 0)
)
from totals;
$$;

revoke all on function public.admin_dashboard_conversion(text, text, text) from public, anon, authenticated;
grant execute on function public.admin_dashboard_conversion(text, text, text) to service_role;
