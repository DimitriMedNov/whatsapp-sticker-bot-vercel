-- 014: el límite de intentos de login deja de vivir en memoria.
--
-- El contador estaba en un Map dentro de la función serverless, así que cada
-- instancia fría empezaba de cero y el tope de 5 intentos por 15 minutos se
-- multiplicaba por el número de instancias activas.

create table if not exists public.admin_login_attempts (
  client_key text primary key check (length(client_key) between 1 and 200),
  failures integer not null default 0 check (failures >= 0),
  reset_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists admin_login_attempts_reset_idx
  on public.admin_login_attempts(reset_at);

alter table public.admin_login_attempts enable row level security;
revoke all on table public.admin_login_attempts from public, anon, authenticated;

-- ¿Está bloqueado este cliente? Aprovecha para limpiar ventanas vencidas.
create or replace function public.admin_login_guard(p_client_key text, p_max_failures integer default 5)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  attempt public.admin_login_attempts;
begin
  delete from public.admin_login_attempts where reset_at <= now();

  select * into attempt
    from public.admin_login_attempts
    where client_key = p_client_key;

  return jsonb_build_object(
    'limited', coalesce(attempt.failures, 0) >= p_max_failures,
    'failures', coalesce(attempt.failures, 0),
    'retry_after_seconds', greatest(coalesce(extract(epoch from attempt.reset_at - now())::integer, 0), 0)
  );
end;
$$;

-- Registra el resultado: un acierto limpia el historial, un fallo lo incrementa.
create or replace function public.admin_login_record(p_client_key text, p_success boolean, p_window_minutes integer default 15)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_failures integer;
begin
  if p_success then
    delete from public.admin_login_attempts where client_key = p_client_key;
    return 0;
  end if;

  insert into public.admin_login_attempts(client_key, failures, reset_at, updated_at)
  values (p_client_key, 1, now() + make_interval(mins => greatest(p_window_minutes, 1)), now())
  on conflict (client_key) do update
    set failures = public.admin_login_attempts.failures + 1,
        updated_at = now()
  returning failures into current_failures;

  return current_failures;
end;
$$;

revoke all on function public.admin_login_guard(text, integer) from public, anon, authenticated;
revoke all on function public.admin_login_record(text, boolean, integer) from public, anon, authenticated;
grant execute on function public.admin_login_guard(text, integer) to service_role;
grant execute on function public.admin_login_record(text, boolean, integer) to service_role;
