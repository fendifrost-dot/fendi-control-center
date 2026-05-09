create table if not exists public.pending_guardian_events (
  id uuid primary key default gen_random_uuid(),
  correlation_id text not null,
  source text not null check (source in ('photo', 'document', 'email', 'manual')),
  file_unique_id text not null,
  client_name text not null,
  cg_client_id uuid,
  event_type text not null check (event_type in ('responses_received', 'outcomes_observed')),
  bureau text not null,
  bureau_canonical text not null,
  round smallint,
  drive_file_id text not null,
  drive_file_name text not null,
  drive_path text not null,
  ocr_text text,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'errored', 'discarded')),
  delivered_at timestamptz,
  delivery_error text,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.pending_guardian_events is
  'Phase 1 intake stub: structured events from the Telegram attachment handler waiting for the Credit Guardian write API (roadmap A4).';

create unique index if not exists pending_guardian_events_correlation_file_uniq
  on public.pending_guardian_events (correlation_id, file_unique_id);

create index if not exists pending_guardian_events_status_received_at_idx
  on public.pending_guardian_events (status, received_at);

create index if not exists pending_guardian_events_client_received_at_idx
  on public.pending_guardian_events (cg_client_id, received_at desc nulls last);

create or replace function public.touch_pending_guardian_events_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;

drop trigger if exists touch_pending_guardian_events_updated_at on public.pending_guardian_events;

create trigger touch_pending_guardian_events_updated_at
  before update on public.pending_guardian_events
  for each row execute function public.touch_pending_guardian_events_updated_at();

alter table public.pending_guardian_events enable row level security;

create policy "Authenticated full access" on public.pending_guardian_events
  for all to public
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

create policy "Service role full access" on public.pending_guardian_events
  for all to service_role
  using (true)
  with check (true);