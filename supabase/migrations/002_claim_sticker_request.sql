create or replace function public.touch_bot_user(p_phone text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.bot_users(phone, last_seen_at)
  values (p_phone, now())
  on conflict (phone) do update set last_seen_at = now();
  return true;
end;
$$;

create or replace function public.claim_sticker_request(
  p_phone text,
  p_message_id text,
  p_input_bytes bigint,
  p_processing_type text,
  p_batch_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_event public.processing_events;
  user_row public.bot_users;
  current_batch public.batch_sessions;
  used_count integer;
  new_event_id bigint;
  rejection text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_phone, 0));

  insert into public.bot_users(phone, last_seen_at)
  values (p_phone, now())
  on conflict (phone) do update set last_seen_at = now()
  returning * into user_row;

  select * into existing_event
    from public.processing_events
    where message_id = p_message_id;

  if existing_event.id is not null then
    return jsonb_build_object(
      'allowed', false, 'reason', 'DUPLICATE', 'event_id', existing_event.id,
      'used', 0, 'limit', 10
    );
  end if;

  if user_row.blocked then rejection := 'BLOCKED';
  elsif p_input_bytes > 5 * 1024 * 1024 then rejection := 'FILE_TOO_LARGE';
  end if;

  select count(*)::integer into used_count
    from public.processing_events
    where phone = p_phone
      and created_at >= now() - interval '1 hour'
      and status in ('accepted', 'processing', 'success');

  if rejection is null and used_count >= 10 then rejection := 'HOURLY_LIMIT'; end if;

  if rejection is null and p_processing_type = 'batch_sticker' then
    select * into current_batch
      from public.batch_sessions
      where id = p_batch_id and phone = p_phone and status = 'open'
        and expires_at > now()
      for update;
    if current_batch.id is null or current_batch.received_count >= current_batch.max_items then
      rejection := 'BATCH_LIMIT';
    else
      update public.batch_sessions
        set received_count = received_count + 1,
            status = case when received_count + 1 >= max_items then 'closed' else status end,
            closed_at = case when received_count + 1 >= max_items then coalesce(closed_at, now()) else closed_at end
        where id = current_batch.id;
    end if;
  end if;

  if rejection is not null then
    insert into public.processing_events(message_id, phone, batch_id, processing_type, status, input_bytes, error_code, completed_at)
    values (p_message_id, p_phone, p_batch_id, p_processing_type, 'rejected', p_input_bytes, rejection, now())
    returning id into new_event_id;
    return jsonb_build_object('allowed', false, 'reason', rejection, 'event_id', new_event_id, 'used', used_count, 'limit', 10);
  end if;

  insert into public.processing_events(message_id, phone, batch_id, processing_type, status, input_bytes)
  values (p_message_id, p_phone, p_batch_id, p_processing_type, 'accepted', p_input_bytes)
  returning id into new_event_id;

  return jsonb_build_object('allowed', true, 'reason', 'ACCEPTED', 'event_id', new_event_id, 'used', used_count + 1, 'limit', 10);
end;
$$;

create or replace function public.mark_sticker_processing(p_event_id bigint)
returns boolean language sql security definer set search_path = public as $$
  update public.processing_events set status = 'processing'
  where id = p_event_id and status = 'accepted'
  returning true;
$$;

create or replace function public.complete_sticker_request(p_event_id bigint, p_output_bytes bigint, p_duration_ms integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare event_row public.processing_events;
begin
  update public.processing_events
    set status = 'success', output_bytes = p_output_bytes, duration_ms = p_duration_ms, completed_at = now()
    where id = p_event_id and status in ('accepted', 'processing')
    returning * into event_row;
  if event_row.id is null then return false; end if;
  if event_row.batch_id is not null then
    update public.batch_sessions set processed_count = processed_count + 1 where id = event_row.batch_id;
  end if;
  return true;
end;
$$;

create or replace function public.fail_sticker_request(p_event_id bigint, p_error_code text, p_error_message text, p_duration_ms integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare event_row public.processing_events;
begin
  update public.processing_events
    set status = 'error', error_code = left(p_error_code, 80), error_message = left(p_error_message, 300), duration_ms = p_duration_ms, completed_at = now()
    where id = p_event_id and status in ('accepted', 'processing')
    returning * into event_row;
  if event_row.id is null then return false; end if;
  if event_row.batch_id is not null then
    update public.batch_sessions set failed_count = failed_count + 1 where id = event_row.batch_id;
  end if;
  return true;
end;
$$;

revoke all on function public.claim_sticker_request(text, text, bigint, text, uuid) from public, anon, authenticated;
revoke all on function public.touch_bot_user(text) from public, anon, authenticated;
revoke all on function public.mark_sticker_processing(bigint) from public, anon, authenticated;
revoke all on function public.complete_sticker_request(bigint, bigint, integer) from public, anon, authenticated;
revoke all on function public.fail_sticker_request(bigint, text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_sticker_request(text, text, bigint, text, uuid) to service_role;
grant execute on function public.touch_bot_user(text) to service_role;
grant execute on function public.mark_sticker_processing(bigint) to service_role;
grant execute on function public.complete_sticker_request(bigint, bigint, integer) to service_role;
grant execute on function public.fail_sticker_request(bigint, text, text, integer) to service_role;
