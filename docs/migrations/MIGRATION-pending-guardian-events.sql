-- ============================================================================
-- MIGRATION: pending_guardian_events
-- Purpose:   Phase 1 of intake-streamlining-plan.md (D1 in the rebuild roadmap)
-- Apply via: Lovable chat — operator does NOT run this directly. Per the
--            roadmap constraint: "Any supabase changes will need to be executed
--            ONLY through lovable chat function by request from lovable as we
--            don't have access to any of the supabase code."
--
-- Background
-- ----------
-- The Hub Telegram bot (telegram-webhook) now accepts photo/document attachments
-- with a `<client> | <bureau> | <round?>` caption. It uploads each attachment
-- to the canonical `<NAME> CREDIT/responses/` folder in Drive, then writes a
-- structured event row to this table.
--
-- This table is a STUB queue. The Credit Guardian write API (roadmap item A4)
-- doesn't exist yet, so the events sit here until that API ships and a future
-- worker drains them into Guardian's timeline. No Hub-side draining is wired
-- up in this PR.
--
-- Hand-off shape — every column maps 1:1 to a field on the eventual Guardian
-- timeline event so the future worker is a straight insert with minimal mapping.
-- ============================================================================

create table if not exists public.pending_guardian_events (
  id uuid primary key default gen_random_uuid(),

  -- Routing + auditing
  correlation_id text not null,                      -- "tg_<update_id>"
  source         text not null                       -- which surface produced this event
    check (source in ('photo', 'document', 'email', 'manual')),
  file_unique_id text not null,                      -- Telegram file_unique_id (stable per file across forwards)

  -- Client identity (cg_client_id may be null when CG-side resolution failed)
  client_name    text not null,
  cg_client_id   uuid,                               -- Credit Guardian (Fairway) client UUID when known

  -- Event payload (matches the eventual Guardian timeline-event shape)
  event_type        text not null                    -- responses_received, outcomes_observed, etc.
    check (event_type in ('responses_received', 'outcomes_observed')),
  bureau            text not null,                   -- pretty label, e.g. "Equifax"
  bureau_canonical  text not null,                   -- slug, e.g. "equifax"
  round             smallint,                        -- nullable — caption may omit round

  -- Drive artifact pointer
  drive_file_id    text not null,
  drive_file_name  text not null,
  drive_path       text not null,                    -- e.g. "SAM CREDIT/responses/"

  -- Phase-2 placeholder. OCR text remains null until Phase 2 (D2) is built.
  ocr_text text,

  -- Lifecycle
  status        text not null default 'pending'
    check (status in ('pending', 'delivered', 'errored', 'discarded')),
  delivered_at  timestamptz,
  delivery_error text,

  received_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.pending_guardian_events is
  'Phase 1 intake stub: structured events from the Telegram attachment handler waiting for the Credit Guardian write API (roadmap A4). The future Guardian-bridge worker drains rows where status=''pending''.';

-- Idempotency. Telegram occasionally re-delivers updates; the webhook''s own
-- update_id idempotency catches most retries, but a (correlation_id, file_unique_id)
-- unique index belt-and-braces against any race that gets past it.
create unique index if not exists pending_guardian_events_correlation_file_uniq
  on public.pending_guardian_events (correlation_id, file_unique_id);

-- Drain index — the worker that eventually delivers these will scan by status.
create index if not exists pending_guardian_events_status_received_at_idx
  on public.pending_guardian_events (status, received_at);

-- Per-client lookup for diagnostics ("show me everything queued for Sam").
create index if not exists pending_guardian_events_client_received_at_idx
  on public.pending_guardian_events (cg_client_id, received_at desc nulls last);

-- updated_at trigger (matches the convention from credit_case_memory).
create or replace function public.touch_pending_guardian_events_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_pending_guardian_events_updated_at on public.pending_guardian_events;
create trigger touch_pending_guardian_events_updated_at
  before update on public.pending_guardian_events
  for each row execute function public.touch_pending_guardian_events_updated_at();

-- ============================================================================
-- ROLLBACK (only run if the table needs to be dropped)
-- ============================================================================
--   drop trigger if exists touch_pending_guardian_events_updated_at on public.pending_guardian_events;
--   drop function if exists public.touch_pending_guardian_events_updated_at();
--   drop table  if exists public.pending_guardian_events;
