-- 012: eventos colgados, índice por fecha y purga opcional.
--
-- Una invocación que muere a mitad de proceso deja su evento en 'accepted' o
-- 'processing' para siempre: inflaba la cola del panel de forma permanente y
-- consumía el límite horario del usuario durante una hora.

-- El dashboard filtra por created_at sobre toda la tabla; el índice compuesto
-- (phone, created_at) no sirve para esos escaneos.
create index if not exists processing_events_created_idx
  on public.processing_events(created_at desc);

-- Cierra como error los eventos que llevan demasiado tiempo sin completarse.
-- El timeout de procesamiento es de 45 s, así que 15 minutos es holgado: lo que
-- siga abierto pasado ese punto no va a terminar nunca.
create or replace function public.reap_stale_processing_events(p_older_than_minutes integer default 15)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  reaped_count integer;
begin
  with stale as (
    update public.processing_events
      set status = 'error',
          error_code = 'PROCESSING_ABANDONED',
          error_message = 'El procesamiento no terminó y se cerró automáticamente.',
          completed_at = now()
      where status in ('accepted', 'processing')
        and created_at < now() - make_interval(mins => greatest(p_older_than_minutes, 1))
      returning batch_id
  ), batch_totals as (
    select batch_id, count(*)::integer as failed_added
    from stale
    where batch_id is not null
    group by batch_id
  ), batch_update as (
    update public.batch_sessions b
      set failed_count = b.failed_count + t.failed_added
      from batch_totals t
      where b.id = t.batch_id
      returning 1
  )
  select count(*)::integer into reaped_count from stale;

  return coalesce(reaped_count, 0);
end;
$$;

-- Purga de histórico. NO se ejecuta sola: sólo existe para que puedas llamarla
-- cuando decidas una política de retención. Borra eventos terminados y los lotes
-- que ya no tienen eventos asociados.
create or replace function public.purge_old_processing_events(p_older_than_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  purged_count integer;
begin
  with removed as (
    delete from public.processing_events
      where created_at < now() - make_interval(days => greatest(p_older_than_days, 1))
        and status in ('success', 'error', 'rejected')
      returning 1
  )
  select count(*)::integer into purged_count from removed;

  delete from public.batch_sessions b
    where b.status in ('closed', 'expired')
      and b.created_at < now() - make_interval(days => greatest(p_older_than_days, 1))
      and not exists (select 1 from public.processing_events e where e.batch_id = b.id);

  return coalesce(purged_count, 0);
end;
$$;

revoke all on function public.reap_stale_processing_events(integer) from public, anon, authenticated;
revoke all on function public.purge_old_processing_events(integer) from public, anon, authenticated;
grant execute on function public.reap_stale_processing_events(integer) to service_role;
grant execute on function public.purge_old_processing_events(integer) to service_role;
