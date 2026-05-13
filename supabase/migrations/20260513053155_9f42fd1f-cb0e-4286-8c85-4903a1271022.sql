alter table public.pending_guardian_events
  add column if not exists retry_count          integer     not null default 0,
  add column if not exists next_retry_at        timestamptz,
  add column if not exists guardian_event_id    text,
  add column if not exists clarification_needed jsonb,
  add column if not exists error_message        text;

alter table public.pending_guardian_events
  drop constraint if exists pending_guardian_events_status_check;

alter table public.pending_guardian_events
  add constraint pending_guardian_events_status_check
  check (status in (
    'pending','delivered','errored','discarded',
    'completed','needs_operator','failed','auth_failed'
  ));

create index if not exists pending_guardian_events_drain_scan_idx
  on public.pending_guardian_events (status, next_retry_at)
  where status = 'pending';

create or replace function public.claim_pending_guardian_events(
  p_limit integer,
  p_now   timestamptz
)
returns table (
  id uuid, correlation_id text, source text, file_unique_id text,
  client_name text, cg_client_id uuid, event_type text, bureau text,
  bureau_canonical text, round smallint, drive_file_id text,
  drive_file_name text, drive_path text, ocr_text text, retry_count integer
)
language sql security definer set search_path = public as $$
  update public.pending_guardian_events t
     set next_retry_at = p_now + interval '5 minutes',
         updated_at    = p_now
   where t.id in (
     select t2.id from public.pending_guardian_events t2
      where t2.status = 'pending'
        and (t2.next_retry_at is null or t2.next_retry_at <= p_now)
      order by t2.received_at asc
      limit p_limit for update skip locked
   )
  returning t.id, t.correlation_id, t.source, t.file_unique_id, t.client_name,
            t.cg_client_id, t.event_type, t.bureau, t.bureau_canonical, t.round,
            t.drive_file_id, t.drive_file_name, t.drive_path, t.ocr_text, t.retry_count;
$$;