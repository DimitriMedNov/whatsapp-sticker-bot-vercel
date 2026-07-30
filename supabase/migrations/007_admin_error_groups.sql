create or replace function public.admin_dashboard_error_groups()
returns jsonb
language sql
security definer
set search_path = public
as $$
with ranked as (
  select
    coalesce(nullif(error_code, ''), 'PROCESSING_ERROR') as code,
    processing_type,
    created_at,
    row_number() over (
      partition by coalesce(nullif(error_code, ''), 'PROCESSING_ERROR')
      order by created_at desc
    ) as sample_rank
  from public.processing_events
  where status = 'error'
    and created_at >= now() - interval '7 days'
), grouped as (
  select
    code,
    count(*) as count,
    max(created_at) as last_seen_at,
    jsonb_agg(
      jsonb_build_object(
        'created_at', created_at,
        'processing_type', processing_type
      ) order by created_at desc
    ) filter (where sample_rank <= 3) as examples
  from ranked
  group by code
)
select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'code', code,
      'count', count,
      'last_seen_at', last_seen_at,
      'examples', coalesce(examples, '[]'::jsonb)
    ) order by count desc, last_seen_at desc
  ),
  '[]'::jsonb
)
from grouped;
$$;

revoke all on function public.admin_dashboard_error_groups() from public, anon, authenticated;
grant execute on function public.admin_dashboard_error_groups() to service_role;
