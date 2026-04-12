-- Case memory for autonomous credit automation (Control Center).
-- Apply via Lovable / Supabase SQL editor when ready.

-- High-level profile: links Hub client to optional Credit Guardian (Fairway) UUID and tracks phase.
create table if not exists public.credit_case_profiles (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  cg_client_id uuid,
  display_name text,
  case_phase text not null default 'intake'
    check (case_phase in ('intake', 'ingesting', 'analysis', 'disputing', 'rebuttal', 'monitoring', 'closed')),
  priority text default 'normal' check (priority in ('low', 'normal', 'high')),
  memory_summary text,
  memory_json jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id)
);

comment on table public.credit_case_profiles is
  'Layer-1 case memory: canonical Hub client + optional CG id + rolling summary for Telegram/decision engine.';

create index if not exists credit_case_profiles_cg_client_id_idx
  on public.credit_case_profiles (cg_client_id)
  where cg_client_id is not null;

-- Dated snapshots (parsed tradelines / scores) for time-series compare.
create table if not exists public.credit_report_snapshots (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  snapshot_label text,
  snapshot_at date,
  source_hint text,
  bureaus jsonb default '[]'::jsonb,
  tradelines jsonb default '[]'::jsonb,
  scores jsonb default '{}'::jsonb,
  raw_fingerprint text,
  created_at timestamptz not null default now()
);

create index if not exists credit_report_snapshots_client_snapshot_at_idx
  on public.credit_report_snapshots (client_id, snapshot_at desc nulls last);

comment on table public.credit_report_snapshots is
  'Structured credit pulls over time; used to detect deletions, reinserts, stagnation.';

-- Discrete dispute outcomes (supplements Fairway timeline_events).
create table if not exists public.credit_dispute_outcomes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  bureau text,
  account_descriptor text,
  outcome_type text not null
    check (outcome_type in ('deleted', 'updated', 'verified', 'reinserted', 'no_change', 'unknown')),
  confidence numeric(4,3),
  detected_at timestamptz not null default now(),
  source_snapshot_id uuid references public.credit_report_snapshots(id) on delete set null,
  prior_snapshot_id uuid references public.credit_report_snapshots(id) on delete set null,
  notes text,
  metadata jsonb default '{}'::jsonb
);

create index if not exists credit_dispute_outcomes_client_detected_idx
  on public.credit_dispute_outcomes (client_id, detected_at desc);

comment on table public.credit_dispute_outcomes is
  'Derived outcomes from snapshot diffing; feeds rebuttals and next dispute selection.';

-- RLS: service role only by default (edge functions use service role).
alter table public.credit_case_profiles enable row level security;
alter table public.credit_report_snapshots enable row level security;
alter table public.credit_dispute_outcomes enable row level security;

-- No policies for anon/authenticated users; backend uses service role.
