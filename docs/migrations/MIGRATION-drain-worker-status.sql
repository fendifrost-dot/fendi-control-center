-- ============================================================================
-- MIGRATION: pending_guardian_events drain-worker status columns + claim RPC
-- Purpose:   Adds the lifecycle columns and atomic-claim RPC required by the
--            drain-guardian-queue edge function (roadmap A4 follow-up to PR #10).
-- Apply via: Lovable chat. Per the standing constraint, the operator does NOT
--            run this directly: "Any supabase changes will need to be executed
--            ONLY through lovable chat function by request from lovable as we
--            don't have access to any of the supabase code."
--
-- Hard dependency: PR #10's MIGRATION-pending-guardian-events.sql must already
-- have been applied. This migration is purely additive on top of that one —
-- no destructive changes; no rewrites of PR #10's columns or indexes.
--
-- What this adds
-- --------------
--   1. Five lifecycle columns on `pending_guardian_events`:
--        retry_count, next_retry_at, guardian_event_id,
--        clarification_needed (jsonb), error_message
--   2. Expanded status check constraint that keeps PR #10's values
--      ('pending', 'delivered', 'errored', 'discarded') and adds the four
--      drain-worker terminal states ('completed', 'needs_operator', 'failed',
--      'auth_failed'). PR #10's handler keeps writing 'pending' as default —
--      that path is unchanged.
--   3. Index on (status, next_retry_at) for efficient drain scans.
--   4. `claim_pending_guardian_events(p_limit, p_now)` RPC — same SKIP LOCKED
--      pattern as `claim_outbox_rows` (telegram-outbox-flush). Returns up to
--      p_limit pending rows whose next_retry_at is null or has elapsed, marks
--      them as in-flight by bumping `next_retry_at` to (p_now + 5 minutes) so
--      a stuck worker's rows aren't re-claimed by the next tick before they
--      either complete or hit the retry path.
-- ============================================================================

-- 1. Lifecycle columns ------------------------------------------------------

alter table public.pending_guardian_events
  add column if not exists retry_count          integer     not null default 0,
  add column if not exists next_retry_at        timestamptz,
  add column if not exists guardian_event_id    text,
  add column if not exists clarification_needed jsonb,
  add column if not exists error_message        text;

comment on column public.pending_guardian_events.retry_count is
  'Number of times the drain worker has attempted to deliver this row. Capped at 5 — beyond that the row moves to status=''failed''.';
comment on column public.pending_guardian_events.next_retry_at is
  'When the drain worker is allowed to retry this row. Set during claim to (now + 5 min) as a soft lease so a stuck tick does not block the queue forever.';
comment on column public.pending_guardian_events.guardian_event_id is
  'Guardian-side timeline-event id returned on a 200 (or idempotent re-call) response from ingest-hub-event.';
comment on column public.pending_guardian_events.clarification_needed is
  'Populated on a 422 response: { candidates: [{id, legal_name}, ...] }. Operator must intervene to resolve the client, then re-queue or update.';
comment on column public.pending_guardian_events.error_message is
  'Last-error string set on 400 / 401 / retry-exhausted / unexpected paths. Free-form, ≤2000 chars.';

-- 2. Expanded status check --------------------------------------------------
-- The PR #10 constraint name is `pending_guardian_events_status_check` (the
-- default Postgres-generated name for a column-level CHECK on `status`). If a
-- different name is in use, replace the DROP target accordingly when applying.

alter table public.pending_guardian_events
  drop constraint if exists pending_guardian_events_status_check;

alter table public.pending_guardian_events
  add constraint pending_guardian_events_status_check
  check (status in (
    'pending',         -- PR #10 default; drain claims these
    'delivered',       -- PR #10 legacy success label (kept for back-compat)
    'errored',         -- PR #10 legacy error label  (kept for back-compat)
    'discarded',       -- PR #10 legacy manual-skip  (kept for back-compat)
    'completed',       -- drain: 200 / idempotent success
    'needs_operator',  -- drain: 422 unresolved client
    'failed',          -- drain: 400 bad input or retry-exhausted
    'auth_failed'      -- drain: 401 signature failure (config issue, not retried)
  ));

-- 3. Drain-scan index -------------------------------------------------------

create index if not exists pending_guardian_events_drain_scan_idx
  on public.pending_guardian_events (status, next_retry_at)
  where status = 'pending';

-- 4. Atomic-claim RPC -------------------------------------------------------
-- Mirrors `claim_outbox_rows` (telegram-outbox-flush). Uses
-- FOR UPDATE SKIP LOCKED so concurrent drain ticks don't double-process,
-- and bumps `next_retry_at` by 5 minutes as a soft lease. Returns the full
-- payload columns the worker needs to build the Guardian POST body.

create or replace function public.claim_pending_guardian_events(
  p_limit integer,
  p_now   timestamptz
)
returns table (
  id                uuid,
  correlation_id    text,
  source            text,
  file_unique_id    text,
  client_name       text,
  cg_client_id      uuid,
  event_type        text,
  bureau            text,
  bureau_canonical  text,
  round             smallint,
  drive_file_id     text,
  drive_file_name   text,
  drive_path        text,
  ocr_text          text,
  retry_count       integer
)
language sql
security definer
set search_path = public
as $$
  update public.pending_guardian_events t
     set next_retry_at = p_now + interval '5 minutes',
         updated_at    = p_now
   where t.id in (
     select t2.id
       from public.pending_guardian_events t2
      where t2.status = 'pending'
        and (t2.next_retry_at is null or t2.next_retry_at <= p_now)
      order by t2.received_at asc
      limit p_limit
        for update skip locked
   )
  returning
    t.id,
    t.correlation_id,
    t.source,
    t.file_unique_id,
    t.client_name,
    t.cg_client_id,
    t.event_type,
    t.bureau,
    t.bureau_canonical,
    t.round,
    t.drive_file_id,
    t.drive_file_name,
    t.drive_path,
    t.ocr_text,
    t.retry_count;
$$;

comment on function public.claim_pending_guardian_events(integer, timestamptz) is
  'Drain-worker claim helper. Atomically locks up to p_limit pending rows whose retry lease has elapsed and bumps their lease by 5 minutes. Mirrors claim_outbox_rows.';

-- ============================================================================
-- ROLLBACK (only if the drain worker is being retired entirely)
-- ============================================================================
--   drop function if exists public.claim_pending_guardian_events(integer, timestamptz);
--   drop index    if exists public.pending_guardian_events_drain_scan_idx;
--   alter table   public.pending_guardian_events drop constraint if exists pending_guardian_events_status_check;
--   alter table   public.pending_guardian_events
--     add constraint pending_guardian_events_status_check
--     check (status in ('pending','delivered','errored','discarded'));
--   alter table   public.pending_guardian_events
--     drop column if exists retry_count,
--     drop column if exists next_retry_at,
--     drop column if exists guardian_event_id,
--     drop column if exists clarification_needed,
--     drop column if exists error_message;
