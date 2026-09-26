-- ============================================================================
-- MUSE EXECUTIVE LAYER (v1)
-- ============================================================================
-- Muse is the executive intelligence / Chief of Staff layer INSIDE the existing
-- Control Hub. It is additive and backward compatible:
--
--   * No existing table, view, function, policy or route is altered or dropped.
--   * Every object created here is prefixed `muse_`.
--   * Muse stores executive INTERPRETATION (loops, decisions, improvements,
--     source authority, conflicts, verifications). It never duplicates raw
--     domain truth — operational facts are read live from the systems that own
--     them via `security_invoker` views.
--
-- Read-only contract: the `muse_reader` role created at the bottom of this file
-- has SELECT on the `muse_*` read views and NOTHING else. The `muse-executive`
-- edge function is GET-only. See docs/MUSE_EXECUTIVE_LAYER.md.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Shared vocabularies (kept as CHECK constraints rather than enums so that
-- adding a value later is a one-line migration and never a type rewrite).
-- ---------------------------------------------------------------------------
--   data_status         KNOWN | AVAILABLE_NOT_CONNECTED | SOURCE_EXISTS_ACCESS_NEEDED
--                       | NOT_MEASURED | UNKNOWN | NEEDS_VERIFICATION
--   verification_state  CLAIMED | ARTIFACT_VERIFIED | SYSTEM_VERIFIED | LIVE_VERIFIED
--   classification      FENDI_DECISION | MUSE_ANALYSIS | DELEGATE_TO_AGENT
--                       | AUTOMATED_SYSTEM | HUMAN_OWNER | WAITING
--   confidence          HIGH | MEDIUM | LOW
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. PORTFOLIO MAP SPINE
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.muse_domains (
  key                 text PRIMARY KEY,
  name                text NOT NULL,
  owner               text NOT NULL DEFAULT 'Fendi',
  status              text NOT NULL DEFAULT 'UNKNOWN',
  systems             jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_of_truth     text,
  current_bottleneck  text,
  current_initiative  text,
  next_review_at      timestamptz,
  data_status         text NOT NULL DEFAULT 'UNKNOWN'
    CONSTRAINT muse_domains_data_status_check CHECK (data_status IN (
      'KNOWN','AVAILABLE_NOT_CONNECTED','SOURCE_EXISTS_ACCESS_NEEDED',
      'NOT_MEASURED','UNKNOWN','NEEDS_VERIFICATION')),
  sort_order          integer NOT NULL DEFAULT 100,
  is_active           boolean NOT NULL DEFAULT true,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.muse_domains IS
  'Muse portfolio map spine: one row per business/domain. Executive interpretation only — operational truth stays in each domain system.';

-- ===========================================================================
-- 2. SOURCE AUTHORITY REGISTER
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.muse_source_authority (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_key            text NOT NULL REFERENCES public.muse_domains(key) ON UPDATE CASCADE,
  subject               text NOT NULL,
  authoritative_system  text NOT NULL,
  secondary_system      text,
  access_status         text NOT NULL DEFAULT 'UNKNOWN'
    CONSTRAINT muse_source_authority_access_status_check CHECK (access_status IN (
      'KNOWN','AVAILABLE_NOT_CONNECTED','SOURCE_EXISTS_ACCESS_NEEDED',
      'NOT_MEASURED','UNKNOWN','NEEDS_VERIFICATION')),
  freshness_target_minutes integer,
  last_verified_at      timestamptz,
  confidence            text NOT NULL DEFAULT 'LOW'
    CONSTRAINT muse_source_authority_confidence_check CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  known_conflict        boolean NOT NULL DEFAULT false,
  reference             text,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT muse_source_authority_domain_subject_key UNIQUE (domain_key, subject)
);

COMMENT ON TABLE public.muse_source_authority IS
  'Where truth lives per domain/subject. Muse consults this instead of treating its own memory as the database.';

-- ===========================================================================
-- 3. OPEN LOOPS
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.muse_open_loops (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_key       text NOT NULL REFERENCES public.muse_domains(key) ON UPDATE CASCADE,
  title            text NOT NULL,
  owner            text,
  state            text NOT NULL DEFAULT 'OPEN'
    CONSTRAINT muse_open_loops_state_check CHECK (state IN (
      'OPEN','IN_PROGRESS','WAITING','BLOCKED','RESOLVED','CANCELLED')),
  classification   text NOT NULL DEFAULT 'MUSE_ANALYSIS'
    CONSTRAINT muse_open_loops_classification_check CHECK (classification IN (
      'FENDI_DECISION','MUSE_ANALYSIS','DELEGATE_TO_AGENT',
      'AUTOMATED_SYSTEM','HUMAN_OWNER','WAITING')),
  category         text NOT NULL DEFAULT 'OPERATIONAL'
    CONSTRAINT muse_open_loops_category_check CHECK (category IN (
      'OPERATIONAL','FINANCIAL','RISK','OPPORTUNITY','COMMITMENT','SYSTEM')),
  priority         text NOT NULL DEFAULT 'P2'
    CONSTRAINT muse_open_loops_priority_check CHECK (priority IN ('P0','P1','P2','P3')),
  dependency       text,
  source           text NOT NULL DEFAULT 'muse',
  source_ref       text,
  last_evidence_at timestamptz,
  next_action      text,
  review_at        timestamptz,
  resolved_at      timestamptz,
  verification_state text NOT NULL DEFAULT 'CLAIMED'
    CONSTRAINT muse_open_loops_verification_check CHECK (verification_state IN (
      'CLAIMED','ARTIFACT_VERIFIED','SYSTEM_VERIFIED','LIVE_VERIFIED')),
  -- When set, `muse_open_loops_live` derives resolution from the named system
  -- probe instead of trusting the stored state. An unattended row must never
  -- read as open merely because nobody updated it.
  derive_resolution_from text,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS muse_open_loops_domain_state_idx
  ON public.muse_open_loops (domain_key, state) WHERE resolved_at IS NULL;

COMMENT ON TABLE public.muse_open_loops IS
  'Unfinished executive work. Resolution is derived from the authoritative system where derive_resolution_from is set.';

-- ===========================================================================
-- 4. DECISION REGISTER
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.muse_decisions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_key           text NOT NULL REFERENCES public.muse_domains(key) ON UPDATE CASCADE,
  question             text NOT NULL,
  context              text,
  evidence             jsonb NOT NULL DEFAULT '[]'::jsonb,
  options              jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner                text NOT NULL DEFAULT 'Fendi',
  classification       text NOT NULL DEFAULT 'FENDI_DECISION'
    CONSTRAINT muse_decisions_classification_check CHECK (classification IN (
      'FENDI_DECISION','MUSE_ANALYSIS','DELEGATE_TO_AGENT',
      'AUTOMATED_SYSTEM','HUMAN_OWNER','WAITING')),
  status               text NOT NULL DEFAULT 'PENDING'
    CONSTRAINT muse_decisions_status_check CHECK (status IN (
      'PENDING','DECIDED','DEFERRED','SUPERSEDED')),
  decision_required_by timestamptz,
  decision             text,
  decided_at           timestamptz,
  review_at            timestamptz,
  source               text NOT NULL DEFAULT 'muse',
  source_ref           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.muse_decisions IS
  'Decisions that need a human owner. Ordinary execution is never routed here — see classification.';

-- ===========================================================================
-- 5. 1% IMPROVEMENT LEDGER
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.muse_improvements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_key      text NOT NULL REFERENCES public.muse_domains(key) ON UPDATE CASCADE,
  baseline        text,
  problem         text NOT NULL,
  intervention    text NOT NULL,
  metric          text NOT NULL,
  expected_result text,
  actual_result   text,
  owner           text NOT NULL DEFAULT 'Fendi',
  started_at      timestamptz,
  review_at       timestamptz,
  verdict         text NOT NULL DEFAULT 'PENDING'
    CONSTRAINT muse_improvements_verdict_check CHECK (verdict IN (
      'PENDING','KEEP','REVISE','REVERSE')),
  status          text NOT NULL DEFAULT 'PROPOSED'
    CONSTRAINT muse_improvements_status_check CHECK (status IN (
      'PROPOSED','RUNNING','MEASURED','CLOSED')),
  verification_state text NOT NULL DEFAULT 'CLAIMED'
    CONSTRAINT muse_improvements_verification_check CHECK (verification_state IN (
      'CLAIMED','ARTIFACT_VERIFIED','SYSTEM_VERIFIED','LIVE_VERIFIED')),
  source_ref      text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.muse_improvements IS
  'Monthly 1% improvement cycle: one row per intervention, closed with keep/revise/reverse against a named metric.';

-- ===========================================================================
-- 6. SYSTEM / AGENT REGISTRY
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.muse_systems (
  key               text PRIMARY KEY,
  name              text NOT NULL,
  role              text NOT NULL,
  domain_key        text REFERENCES public.muse_domains(key) ON UPDATE CASCADE,
  expected_cadence  text NOT NULL DEFAULT 'ad hoc',
  -- NULL cadence_minutes = event driven; staleness is then not an error.
  cadence_minutes   integer,
  -- Matches muse_system_probe.probe_key. NULL = no telemetry reachable yet.
  probe_key         text,
  owner_type        text NOT NULL DEFAULT 'AUTOMATED_SYSTEM'
    CONSTRAINT muse_systems_owner_type_check CHECK (owner_type IN (
      'FENDI_DECISION','MUSE_ANALYSIS','DELEGATE_TO_AGENT',
      'AUTOMATED_SYSTEM','HUMAN_OWNER','WAITING')),
  blocker           text,
  -- true when this probe's pending_count means "waiting on a human", not a fault.
  waits_on_human    boolean NOT NULL DEFAULT false,
  downstream_impact text,
  data_status       text NOT NULL DEFAULT 'UNKNOWN'
    CONSTRAINT muse_systems_data_status_check CHECK (data_status IN (
      'KNOWN','AVAILABLE_NOT_CONNECTED','SOURCE_EXISTS_ACCESS_NEEDED',
      'NOT_MEASURED','UNKNOWN','NEEDS_VERIFICATION')),
  is_active         boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 100,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.muse_systems IS
  'Agents, functions, webhooks and cron routes Muse watches. Cadence and impact are declared here; last run/failure is derived, never stored.';

-- ===========================================================================
-- 7. SOURCE CONFLICTS  (never silently choose)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.muse_source_conflicts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_key          text NOT NULL REFERENCES public.muse_domains(key) ON UPDATE CASCADE,
  subject             text NOT NULL,
  system_a            text NOT NULL,
  value_a             text NOT NULL,
  reference_a         text,
  system_b            text NOT NULL,
  value_b             text NOT NULL,
  reference_b         text,
  candidate_authority text,
  status              text NOT NULL DEFAULT 'OPEN'
    CONSTRAINT muse_source_conflicts_status_check CHECK (status IN ('OPEN','RESOLVED','STALE')),
  detected_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  resolution_notes    text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.muse_source_conflicts IS
  'Both sides of a disagreement are preserved with references; candidate_authority is a proposal, not a silent overwrite.';

-- ===========================================================================
-- 8. VERIFICATION LEDGER  ("an agent saying done is not completion")
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.muse_verifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type       text NOT NULL,
  subject_ref        text NOT NULL,
  claim              text NOT NULL,
  verification_state text NOT NULL DEFAULT 'CLAIMED'
    CONSTRAINT muse_verifications_state_check CHECK (verification_state IN (
      'CLAIMED','ARTIFACT_VERIFIED','SYSTEM_VERIFIED','LIVE_VERIFIED')),
  claimed_by         text,
  claimed_at         timestamptz NOT NULL DEFAULT now(),
  repo               text,
  branch             text,
  commit_sha         text,
  evidence_url       text,
  verified_by        text,
  verified_at        timestamptz,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS muse_verifications_subject_idx
  ON public.muse_verifications (subject_type, subject_ref);

COMMENT ON TABLE public.muse_verifications IS
  'Claim -> artifact -> system -> live progression. GitHub remains the source of truth for code; a commit alone never means deployed.';

-- ===========================================================================
-- 9. KPI REGISTRY  (definitions only — values are derived)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.muse_kpi_registry (
  metric_key    text PRIMARY KEY,
  domain_key    text NOT NULL REFERENCES public.muse_domains(key) ON UPDATE CASCADE,
  name          text NOT NULL,
  unit          text NOT NULL DEFAULT 'count',
  direction     text NOT NULL DEFAULT 'UP_IS_GOOD'
    CONSTRAINT muse_kpi_registry_direction_check CHECK (direction IN ('UP_IS_GOOD','DOWN_IS_GOOD','NEUTRAL')),
  source_system text NOT NULL,
  -- Matches muse_kpi_derived.metric_key when Control Hub can compute it.
  is_derived    boolean NOT NULL DEFAULT false,
  target        text,
  data_status   text NOT NULL DEFAULT 'NOT_MEASURED'
    CONSTRAINT muse_kpi_registry_data_status_check CHECK (data_status IN (
      'KNOWN','AVAILABLE_NOT_CONNECTED','SOURCE_EXISTS_ACCESS_NEEDED',
      'NOT_MEASURED','UNKNOWN','NEEDS_VERIFICATION')),
  is_primary    boolean NOT NULL DEFAULT false,
  sort_order    integer NOT NULL DEFAULT 100,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.muse_kpi_registry IS
  'Declares which metrics matter per domain and whether Control Hub can currently compute them. No metric is invented where data is unavailable.';

-- ===========================================================================
-- 10. READ-ONLY API SURFACE SUPPORT (tokens + audit)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.muse_api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label        text NOT NULL,
  -- SHA-256 hex of the bearer token. The token itself is never stored.
  token_sha256 text NOT NULL UNIQUE,
  scopes       text[] NOT NULL DEFAULT ARRAY['read']::text[],
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  notes        text
);

COMMENT ON TABLE public.muse_api_tokens IS
  'Hashed bearer tokens for the muse-executive read API. Rotatable and revocable; no plaintext token or service-role key is ever stored here.';

CREATE TABLE IF NOT EXISTS public.muse_access_audit (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  token_label text,
  resource    text NOT NULL,
  method      text NOT NULL,
  http_status integer NOT NULL,
  ip_hash     text,
  user_agent  text,
  note        text
);

CREATE INDEX IF NOT EXISTS muse_access_audit_at_idx ON public.muse_access_audit (at DESC);
CREATE INDEX IF NOT EXISTS muse_access_audit_token_at_idx ON public.muse_access_audit (token_label, at DESC);

COMMENT ON TABLE public.muse_access_audit IS
  'Every muse-executive request, allowed or rejected. Also backs the fixed-window rate limiter.';

-- ===========================================================================
-- 11. ROW LEVEL SECURITY ON MUSE TABLES
-- ===========================================================================
-- Matches the existing Control Hub convention (authenticated operator + service
-- role). `anon` is granted nothing anywhere in this file.
ALTER TABLE public.muse_domains           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_source_authority  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_open_loops        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_decisions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_improvements      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_systems           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_source_conflicts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_verifications     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_kpi_registry      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_api_tokens        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_access_audit      ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'muse_domains','muse_source_authority','muse_open_loops','muse_decisions',
    'muse_improvements','muse_systems','muse_source_conflicts',
    'muse_verifications','muse_kpi_registry'
  ] LOOP
    -- Operator (Fendi, signed into the Control Hub) curates the executive layer.
    EXECUTE format(
      'DROP POLICY IF EXISTS "Authenticated full access" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "Authenticated full access" ON public.%I FOR ALL TO authenticated USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL)', t);
    EXECUTE format(
      'DROP POLICY IF EXISTS "Service role full access" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "Service role full access" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- Token material and the access log are service-role only: the browser never
-- needs them, and a compromised operator session must not be able to mint or
-- read API credentials or rewrite the audit trail.
DROP POLICY IF EXISTS "Service role only" ON public.muse_api_tokens;
CREATE POLICY "Service role only" ON public.muse_api_tokens
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Service role only" ON public.muse_access_audit;
CREATE POLICY "Service role only" ON public.muse_access_audit
  FOR ALL TO service_role USING (true) WITH CHECK (true);
-- The operator may read (not write) the audit trail from the Hub UI.
DROP POLICY IF EXISTS "Authenticated read audit" ON public.muse_access_audit;
CREATE POLICY "Authenticated read audit" ON public.muse_access_audit
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- ---------------------------------------------------------------------------
-- updated_at maintenance (muse_* only; no existing trigger is touched)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.muse_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'muse_domains','muse_source_authority','muse_open_loops','muse_decisions',
    'muse_improvements','muse_systems','muse_source_conflicts',
    'muse_verifications','muse_kpi_registry'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_touch', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.muse_touch_updated_at()',
      t || '_touch', t);
  END LOOP;
END $$;

-- ===========================================================================
-- 12. SYSTEM PROBES — derived telemetry, never stored
-- ===========================================================================
-- One row per probe_key. Every column is computed live from the table that owns
-- the fact, so Muse cannot drift from the operational system. Counts use a
-- 7-day window so a long-dead failure does not read as a current one.
--
-- Only tables present in the live generated schema
-- (src/integrations/supabase/types.ts) are referenced here.
CREATE OR REPLACE VIEW public.muse_system_probe AS
WITH drive_sync AS (
  SELECT
    'drive_sync'::text AS probe_key,
    max(completed_at) FILTER (WHERE completed_at IS NOT NULL AND last_error IS NULL) AS last_success_at,
    max(coalesce(completed_at, started_at)) FILTER (WHERE last_error IS NOT NULL) AS last_failure_at,
    (array_agg(last_error ORDER BY coalesce(completed_at, started_at) DESC)
       FILTER (WHERE last_error IS NOT NULL))[1] AS last_failure_detail,
    max(coalesce(completed_at, started_at)) AS latest_activity_at,
    count(*) FILTER (WHERE completed_at IS NULL) AS pending_count,
    count(*) FILTER (WHERE last_error IS NOT NULL
                       AND coalesce(completed_at, started_at) > now() - interval '7 days') AS failing_count
  FROM public.drive_sync_runs
), ingestion AS (
  SELECT
    'ingestion_jobs'::text,
    max(completed_at) FILTER (WHERE completed_at IS NOT NULL AND last_error IS NULL),
    max(coalesce(completed_at, updated_at, created_at)) FILTER (WHERE last_error IS NOT NULL),
    (array_agg(last_error ORDER BY coalesce(completed_at, updated_at, created_at) DESC)
       FILTER (WHERE last_error IS NOT NULL))[1],
    max(coalesce(completed_at, updated_at, created_at)),
    count(*) FILTER (WHERE completed_at IS NULL),
    count(*) FILTER (WHERE last_error IS NOT NULL
                       AND coalesce(completed_at, updated_at, created_at) > now() - interval '7 days')
  FROM public.ingestion_jobs
), statement_chunks AS (
  SELECT
    'statement_chunk_jobs'::text,
    max(completed_at) FILTER (WHERE completed_at IS NOT NULL AND last_error IS NULL),
    max(coalesce(completed_at, updated_at, created_at)) FILTER (WHERE last_error IS NOT NULL OR prep_error IS NOT NULL),
    (array_agg(coalesce(last_error, prep_error) ORDER BY coalesce(completed_at, updated_at, created_at) DESC)
       FILTER (WHERE last_error IS NOT NULL OR prep_error IS NOT NULL))[1],
    max(coalesce(completed_at, updated_at, created_at)),
    count(*) FILTER (WHERE completed_at IS NULL),
    count(*) FILTER (WHERE (last_error IS NOT NULL OR prep_error IS NOT NULL)
                       AND coalesce(completed_at, updated_at, created_at) > now() - interval '7 days')
  FROM public.statement_chunk_jobs
), outbox AS (
  SELECT
    'telegram_outbox'::text,
    max(sent_at),
    max(coalesce(last_attempt_at, updated_at, created_at)) FILTER (WHERE last_error IS NOT NULL),
    (array_agg(last_error ORDER BY coalesce(last_attempt_at, updated_at, created_at) DESC)
       FILTER (WHERE last_error IS NOT NULL))[1],
    max(coalesce(sent_at, last_attempt_at, updated_at, created_at)),
    count(*) FILTER (WHERE sent_at IS NULL AND status <> 'sent'),
    count(*) FILTER (WHERE last_error IS NOT NULL
                       AND coalesce(last_attempt_at, updated_at, created_at) > now() - interval '7 days')
  FROM public.telegram_outbox
), webhook AS (
  -- Success-only heartbeat: the table records accepted updates, so absence of
  -- rows is silence, never a failure.
  SELECT
    'telegram_webhook'::text,
    max(received_at),
    NULL::timestamptz,
    NULL::text,
    max(received_at),
    0::bigint,
    0::bigint
  FROM public.telegram_webhook_processed_updates
), guardian AS (
  SELECT
    'guardian_queue'::text,
    max(delivered_at),
    max(updated_at) FILTER (WHERE status = 'errored' OR delivery_error IS NOT NULL OR error_message IS NOT NULL),
    (array_agg(coalesce(delivery_error, error_message) ORDER BY updated_at DESC)
       FILTER (WHERE delivery_error IS NOT NULL OR error_message IS NOT NULL))[1],
    max(coalesce(delivered_at, updated_at, received_at)),
    count(*) FILTER (WHERE status = 'pending'),
    count(*) FILTER (WHERE status = 'errored' AND updated_at > now() - interval '7 days')
  FROM public.pending_guardian_events
), workflows AS (
  SELECT
    'workflow_runner'::text,
    max(updated_at) FILTER (WHERE status ~* '^(completed|succeeded|success|done|finished)$'
                              AND last_error IS NULL AND error IS NULL),
    max(updated_at) FILTER (WHERE last_error IS NOT NULL OR error IS NOT NULL OR status ~* '(fail|error)'),
    (array_agg(coalesce(last_error, error::text) ORDER BY updated_at DESC)
       FILTER (WHERE last_error IS NOT NULL OR error IS NOT NULL))[1],
    max(coalesce(updated_at, created_at)),
    count(*) FILTER (WHERE status ~* '^(running|queued|pending)$'),
    count(*) FILTER (WHERE (last_error IS NOT NULL OR error IS NOT NULL OR status ~* '(fail|error)')
                       AND updated_at > now() - interval '7 days')
  FROM public.workflow_runs
), remote_queue AS (
  SELECT
    'remote_command_queue'::text,
    max(completed_at) FILTER (WHERE completed_at IS NOT NULL AND error IS NULL),
    max(coalesce(completed_at, updated_at)) FILTER (WHERE error IS NOT NULL),
    (array_agg(error ORDER BY coalesce(completed_at, updated_at) DESC)
       FILTER (WHERE error IS NOT NULL))[1],
    max(coalesce(completed_at, claimed_at, updated_at, created_at)),
    count(*) FILTER (WHERE status = 'queued' AND expires_at > now()),
    count(*) FILTER (WHERE error IS NOT NULL AND coalesce(completed_at, updated_at) > now() - interval '7 days')
  FROM public.remote_command_queue
), bridge AS (
  SELECT
    'remote_bridge_device'::text,
    max(last_seen_at) FILTER (WHERE status = 'active'),
    NULL::timestamptz,
    NULL::text,
    max(coalesce(last_seen_at, updated_at)),
    0::bigint,
    0::bigint
  FROM public.remote_bridge_devices
), tool_calls AS (
  SELECT
    'cc_tool_executor'::text,
    max(coalesce(completed_at, started_at)) FILTER (WHERE status = 'succeeded'),
    max(coalesce(completed_at, started_at)) FILTER (WHERE status = 'failed'),
    (array_agg(error ORDER BY coalesce(completed_at, started_at) DESC)
       FILTER (WHERE status = 'failed'))[1],
    max(coalesce(completed_at, started_at)),
    count(*) FILTER (WHERE status = 'attempted' AND completed_at IS NULL),
    count(*) FILTER (WHERE status = 'failed' AND coalesce(completed_at, started_at) > now() - interval '7 days')
  FROM public.tool_execution_logs
), agent_tasks AS (
  SELECT
    'agent_task_loop'::text,
    max(updated_at) FILTER (WHERE status ~* '^(succeeded|success|completed|done)$'),
    max(updated_at) FILTER (WHERE status ~* '(fail|error)' OR error IS NOT NULL),
    (array_agg(error ORDER BY updated_at DESC) FILTER (WHERE error IS NOT NULL))[1],
    max(coalesce(updated_at, created_at)),
    count(*) FILTER (WHERE status ~* '^(queued|running)$'),
    count(*) FILTER (WHERE (status ~* '(fail|error)' OR error IS NOT NULL)
                       AND updated_at > now() - interval '7 days')
  FROM public.tasks
), approvals AS (
  -- pending_count here is work waiting on a human, not a malfunction.
  SELECT
    'telegram_approval_queue'::text,
    max(resolved_at),
    NULL::timestamptz,
    NULL::text,
    max(coalesce(resolved_at, created_at)),
    count(*) FILTER (WHERE status = 'pending'),
    0::bigint
  FROM public.telegram_approval_queue
)
SELECT * FROM drive_sync
UNION ALL SELECT * FROM ingestion
UNION ALL SELECT * FROM statement_chunks
UNION ALL SELECT * FROM outbox
UNION ALL SELECT * FROM webhook
UNION ALL SELECT * FROM guardian
UNION ALL SELECT * FROM workflows
UNION ALL SELECT * FROM remote_queue
UNION ALL SELECT * FROM bridge
UNION ALL SELECT * FROM tool_calls
UNION ALL SELECT * FROM agent_tasks
UNION ALL SELECT * FROM approvals;

COMMENT ON VIEW public.muse_system_probe IS
  'Live telemetry derived from the tables that own each fact. Muse never stores last-run state.';

-- ===========================================================================
-- 13. SYSTEM / AGENT HEALTH
-- ===========================================================================
-- Declared cadence (registry) x observed telemetry (probe) -> a status Muse can
-- act on. A system with no reachable telemetry reads NOT_MEASURED, never
-- "healthy".
CREATE OR REPLACE VIEW public.muse_system_health AS
SELECT
  s.key                        AS system_key,
  s.name,
  s.role,
  s.domain_key,
  s.expected_cadence,
  s.cadence_minutes,
  s.owner_type                 AS classification,
  p.last_success_at,
  p.last_failure_at,
  p.last_failure_detail,
  p.latest_activity_at,
  coalesce(p.pending_count, 0)  AS pending_count,
  coalesce(p.failing_count, 0)  AS failing_count,
  s.waits_on_human,
  CASE
    WHEN NOT s.is_active                          THEN 'DISABLED'
    WHEN s.probe_key IS NULL                      THEN 'NOT_OBSERVED'
    WHEN p.probe_key IS NULL                      THEN 'NOT_OBSERVED'
    WHEN p.last_success_at IS NULL
         AND p.last_failure_at IS NULL            THEN 'NEVER_RAN'
    WHEN p.last_failure_at IS NOT NULL
         AND (p.last_success_at IS NULL
              OR p.last_failure_at > p.last_success_at) THEN 'FAILING'
    WHEN s.cadence_minutes IS NOT NULL
         AND p.last_success_at < now() - make_interval(mins => s.cadence_minutes * 2)
                                                  THEN 'STALE'
    WHEN p.last_success_at IS NOT NULL            THEN 'HEALTHY'
    ELSE 'UNKNOWN'
  END AS status,
  CASE
    WHEN NOT s.is_active OR s.probe_key IS NULL OR p.probe_key IS NULL
      THEN s.data_status
    WHEN p.last_success_at IS NULL AND p.last_failure_at IS NULL
      THEN 'NOT_MEASURED'
    ELSE 'KNOWN'
  END AS data_status,
  s.blocker,
  s.downstream_impact,
  s.probe_key,
  s.notes,
  s.sort_order,
  now() AS as_of
FROM public.muse_systems s
LEFT JOIN public.muse_system_probe p ON p.probe_key = s.probe_key
WHERE s.is_active;

COMMENT ON VIEW public.muse_system_health IS
  'Agent/system health: role, expected cadence, last success, last failure, current status, blocker, downstream impact.';

-- ===========================================================================
-- 14. OPEN LOOPS (live)
-- ===========================================================================
-- Stored state is the executive intent; where derive_resolution_from names a
-- system probe, the authoritative system decides whether the loop is still
-- real. Staleness is surfaced so an untouched row cannot masquerade as current.
CREATE OR REPLACE VIEW public.muse_open_loops_live AS
SELECT
  l.id,
  l.domain_key,
  d.name AS domain_name,
  l.title,
  l.owner,
  l.classification,
  l.category,
  l.priority,
  l.dependency,
  l.source,
  l.source_ref,
  l.last_evidence_at,
  l.next_action,
  l.review_at,
  l.resolved_at,
  l.verification_state,
  l.notes,
  -- Derived state: a probe that has gone quiet or clean overrides a stale OPEN.
  CASE
    WHEN l.resolved_at IS NOT NULL THEN l.state
    WHEN l.derive_resolution_from IS NOT NULL
         AND h.system_key IS NOT NULL
         AND h.status = 'HEALTHY'
         AND coalesce(h.failing_count, 0) = 0 THEN 'RESOLVED'
    ELSE l.state
  END AS state,
  l.state AS stored_state,
  l.derive_resolution_from,
  h.status AS derived_system_status,
  CASE
    WHEN l.resolved_at IS NOT NULL THEN false
    WHEN l.derive_resolution_from IS NOT NULL THEN false
    WHEN l.last_evidence_at IS NULL THEN true
    WHEN l.last_evidence_at < now() - interval '30 days' THEN true
    ELSE false
  END AS evidence_stale,
  (l.review_at IS NOT NULL AND l.review_at < now() AND l.resolved_at IS NULL) AS review_overdue,
  CASE
    WHEN l.derive_resolution_from IS NOT NULL AND h.system_key IS NOT NULL THEN 'KNOWN'
    WHEN l.last_evidence_at IS NULL THEN 'NEEDS_VERIFICATION'
    WHEN l.last_evidence_at < now() - interval '30 days' THEN 'NEEDS_VERIFICATION'
    ELSE 'KNOWN'
  END AS data_status,
  now() AS as_of
FROM public.muse_open_loops l
JOIN public.muse_domains d ON d.key = l.domain_key
LEFT JOIN public.muse_system_health h ON h.system_key = l.derive_resolution_from;

COMMENT ON VIEW public.muse_open_loops_live IS
  'Open loops with resolution and staleness derived from the authoritative system, so an un-updated row is not silently trusted.';

-- ===========================================================================
-- 15. DECISIONS REQUIRED
-- ===========================================================================
CREATE OR REPLACE VIEW public.muse_decisions_required AS
SELECT
  dc.id,
  dc.domain_key,
  d.name AS domain_name,
  dc.question,
  dc.context,
  dc.evidence,
  dc.options,
  dc.owner,
  dc.classification,
  dc.status,
  dc.decision_required_by,
  dc.review_at,
  dc.source,
  dc.source_ref,
  (dc.decision_required_by IS NOT NULL AND dc.decision_required_by < now()) AS overdue,
  CASE
    WHEN dc.decision_required_by IS NULL THEN NULL
    ELSE date_part('day', dc.decision_required_by - now())::integer
  END AS days_remaining,
  dc.created_at,
  now() AS as_of
FROM public.muse_decisions dc
JOIN public.muse_domains d ON d.key = dc.domain_key
WHERE dc.status IN ('PENDING','DEFERRED');

COMMENT ON VIEW public.muse_decisions_required IS
  'Decisions still owed by a human owner, with overdue and days-remaining derived at read time.';

-- ===========================================================================
-- 16. KPI VALUES — derived only where Control Hub owns the data
-- ===========================================================================
CREATE OR REPLACE VIEW public.muse_kpi_derived AS
SELECT 'cc.tax_returns_open'::text AS metric_key,
       count(*)::numeric AS value,
       max(coalesce(updated_at, created_at)) AS data_timestamp,
       'public.tax_returns'::text AS source_table
FROM public.tax_returns WHERE coalesce(status,'') <> 'filed'
UNION ALL
SELECT 'cc.tax_returns_filed_ytd',
       count(*)::numeric,
       max(filed_at),
       'public.tax_returns'
FROM public.tax_returns
WHERE filed_at IS NOT NULL AND filed_at >= date_trunc('year', now())
UNION ALL
SELECT 'cc.clients_total',
       count(*)::numeric,
       max(created_at),
       'public.clients'
FROM public.clients
UNION ALL
SELECT 'cc.dispute_letters_30d',
       count(*)::numeric,
       max(created_at),
       'public.dispute_letters'
FROM public.dispute_letters WHERE created_at >= now() - interval '30 days'
UNION ALL
SELECT 'cc.marketing_spend_30d',
       coalesce(sum(spend), 0)::numeric,
       max(date)::timestamptz,
       'public.marketing_spend'
FROM public.marketing_spend WHERE date >= (now() - interval '30 days')::date
UNION ALL
SELECT 'cc.marketing_conversions_30d',
       coalesce(sum(conversions), 0)::numeric,
       max(date)::timestamptz,
       'public.marketing_spend'
FROM public.marketing_spend WHERE date >= (now() - interval '30 days')::date
UNION ALL
SELECT 'music.pitch_drafts_30d',
       count(*)::numeric,
       max(coalesce(updated_at, created_at)),
       'public.pitch_drafts'
FROM public.pitch_drafts WHERE coalesce(created_at, now()) >= now() - interval '30 days'
UNION ALL
SELECT 'music.playlist_research_30d',
       count(*)::numeric,
       max(coalesce(updated_at, created_at)),
       'public.playlist_research'
FROM public.playlist_research WHERE coalesce(created_at, now()) >= now() - interval '30 days'
UNION ALL
SELECT 'ai.tool_failures_7d',
       count(*)::numeric,
       max(coalesce(completed_at, started_at)),
       'public.tool_execution_logs'
FROM public.tool_execution_logs
WHERE status = 'failed' AND coalesce(completed_at, started_at) >= now() - interval '7 days'
UNION ALL
SELECT 'ai.tool_calls_7d',
       count(*)::numeric,
       max(coalesce(completed_at, started_at)),
       'public.tool_execution_logs'
FROM public.tool_execution_logs
WHERE coalesce(completed_at, started_at) >= now() - interval '7 days'
UNION ALL
SELECT 'ai.approvals_pending',
       count(*)::numeric,
       max(created_at),
       'public.telegram_approval_queue'
FROM public.telegram_approval_queue WHERE status = 'pending';

COMMENT ON VIEW public.muse_kpi_derived IS
  'The only KPI values Control Hub can compute from data it owns today. Everything else stays unmeasured by design.';

CREATE OR REPLACE VIEW public.muse_kpi_summary AS
SELECT
  r.metric_key,
  r.domain_key,
  d.name AS domain_name,
  r.name,
  r.unit,
  r.direction,
  r.source_system,
  r.target,
  r.is_primary,
  v.value,
  v.data_timestamp,
  v.source_table AS evidence_ref,
  CASE
    WHEN r.is_derived AND v.metric_key IS NOT NULL THEN 'KNOWN'
    WHEN r.is_derived AND v.metric_key IS NULL THEN 'NEEDS_VERIFICATION'
    ELSE r.data_status
  END AS data_status,
  CASE
    WHEN r.is_derived AND v.metric_key IS NOT NULL THEN 'HIGH'
    WHEN r.data_status IN ('SOURCE_EXISTS_ACCESS_NEEDED','AVAILABLE_NOT_CONNECTED') THEN 'LOW'
    ELSE 'LOW'
  END AS confidence,
  (NOT r.is_derived) AS human_verification_required,
  r.notes,
  r.sort_order,
  now() AS as_of
FROM public.muse_kpi_registry r
JOIN public.muse_domains d ON d.key = r.domain_key
LEFT JOIN public.muse_kpi_derived v ON v.metric_key = r.metric_key;

COMMENT ON VIEW public.muse_kpi_summary IS
  'Declared KPIs joined to computed values. A registered metric with no derivation reports its honest status instead of a number.';

-- ===========================================================================
-- 17. SOURCE AUTHORITY STATE  (freshness computed, not asserted)
-- ===========================================================================
CREATE OR REPLACE VIEW public.muse_source_authority_state AS
SELECT
  sa.id,
  sa.domain_key,
  d.name AS domain_name,
  sa.subject,
  sa.authoritative_system,
  sa.secondary_system,
  sa.access_status,
  sa.freshness_target_minutes,
  sa.last_verified_at,
  sa.confidence,
  sa.known_conflict,
  sa.reference,
  sa.notes,
  CASE
    WHEN sa.last_verified_at IS NULL THEN NULL
    ELSE floor(extract(epoch FROM (now() - sa.last_verified_at)) / 60)::bigint
  END AS minutes_since_verified,
  CASE
    WHEN sa.last_verified_at IS NULL THEN 'NEVER_VERIFIED'
    WHEN sa.freshness_target_minutes IS NULL THEN 'NO_TARGET'
    WHEN sa.last_verified_at > now() - make_interval(mins => sa.freshness_target_minutes) THEN 'FRESH'
    ELSE 'STALE'
  END AS freshness,
  (sa.last_verified_at IS NULL
     OR sa.access_status IN ('UNKNOWN','NEEDS_VERIFICATION','SOURCE_EXISTS_ACCESS_NEEDED')) AS human_verification_required,
  (SELECT count(*) FROM public.muse_source_conflicts c
    WHERE c.domain_key = sa.domain_key AND c.status = 'OPEN') AS open_conflicts,
  now() AS as_of
FROM public.muse_source_authority sa
JOIN public.muse_domains d ON d.key = sa.domain_key;

COMMENT ON VIEW public.muse_source_authority_state IS
  'Source authority register with freshness derived from last_verified_at against the declared target.';

CREATE OR REPLACE VIEW public.muse_source_conflicts_open AS
SELECT
  c.id, c.domain_key, d.name AS domain_name, c.subject,
  c.system_a, c.value_a, c.reference_a,
  c.system_b, c.value_b, c.reference_b,
  c.candidate_authority, c.status, c.detected_at, c.resolved_at, c.resolution_notes,
  'NEEDS_VERIFICATION'::text AS data_status,
  true AS human_verification_required,
  now() AS as_of
FROM public.muse_source_conflicts c
JOIN public.muse_domains d ON d.key = c.domain_key
WHERE c.status = 'OPEN';

-- ===========================================================================
-- 18. 1% IMPROVEMENT LEDGER
-- ===========================================================================
CREATE OR REPLACE VIEW public.muse_improvement_ledger AS
SELECT
  i.id,
  i.domain_key,
  d.name AS domain_name,
  i.baseline,
  i.problem,
  i.intervention,
  i.metric,
  i.expected_result,
  i.actual_result,
  i.owner,
  i.started_at,
  i.review_at,
  i.verdict,
  i.status,
  i.verification_state,
  i.source_ref,
  i.notes,
  (i.review_at IS NOT NULL AND i.review_at < now() AND i.verdict = 'PENDING') AS review_due,
  (i.actual_result IS NULL AND i.status IN ('RUNNING','MEASURED')) AS awaiting_measurement,
  CASE
    WHEN i.actual_result IS NOT NULL AND i.verification_state IN ('SYSTEM_VERIFIED','LIVE_VERIFIED') THEN 'KNOWN'
    WHEN i.actual_result IS NOT NULL THEN 'NEEDS_VERIFICATION'
    ELSE 'NOT_MEASURED'
  END AS data_status,
  i.created_at,
  now() AS as_of
FROM public.muse_improvements i
JOIN public.muse_domains d ON d.key = i.domain_key;

COMMENT ON VIEW public.muse_improvement_ledger IS
  'Monthly 1% cycle. A row without a measured actual_result reads NOT_MEASURED, and a verdict cannot be justified by an agent claim alone.';

-- ===========================================================================
-- 19. PORTFOLIO MAP
-- ===========================================================================
CREATE OR REPLACE VIEW public.muse_portfolio_map AS
SELECT
  d.key AS domain_key,
  d.name,
  d.owner,
  d.status,
  d.systems,
  d.source_of_truth,
  d.current_bottleneck,
  d.current_initiative,
  d.next_review_at,
  d.data_status,
  d.notes,
  d.sort_order,
  (SELECT count(*) FROM public.muse_open_loops_live l
    WHERE l.domain_key = d.key AND l.state NOT IN ('RESOLVED','CANCELLED')) AS open_loops,
  (SELECT count(*) FROM public.muse_open_loops_live l
    WHERE l.domain_key = d.key AND l.state = 'BLOCKED') AS blocked_loops,
  (SELECT count(*) FROM public.muse_decisions_required dr
    WHERE dr.domain_key = d.key) AS decisions_pending,
  (SELECT count(*) FROM public.muse_source_conflicts c
    WHERE c.domain_key = d.key AND c.status = 'OPEN') AS open_conflicts,
  (SELECT count(*) FROM public.muse_improvement_ledger il
    WHERE il.domain_key = d.key AND il.status IN ('PROPOSED','RUNNING','MEASURED')) AS active_improvements,
  (SELECT count(*) FROM public.muse_system_health h
    WHERE h.domain_key = d.key AND h.status IN ('FAILING','STALE')) AS unhealthy_systems,
  -- Primary KPI, when one is both declared and computable.
  (SELECT k.name FROM public.muse_kpi_summary k
    WHERE k.domain_key = d.key AND k.is_primary ORDER BY k.sort_order LIMIT 1) AS primary_kpi_name,
  (SELECT k.value FROM public.muse_kpi_summary k
    WHERE k.domain_key = d.key AND k.is_primary ORDER BY k.sort_order LIMIT 1) AS primary_kpi_value,
  (SELECT k.unit FROM public.muse_kpi_summary k
    WHERE k.domain_key = d.key AND k.is_primary ORDER BY k.sort_order LIMIT 1) AS primary_kpi_unit,
  (SELECT k.data_status FROM public.muse_kpi_summary k
    WHERE k.domain_key = d.key AND k.is_primary ORDER BY k.sort_order LIMIT 1) AS primary_kpi_status,
  (SELECT k.data_timestamp FROM public.muse_kpi_summary k
    WHERE k.domain_key = d.key AND k.is_primary ORDER BY k.sort_order LIMIT 1) AS primary_kpi_at,
  (SELECT min(sa.last_verified_at) FROM public.muse_source_authority sa
    WHERE sa.domain_key = d.key) AS sources_last_verified_at,
  now() AS as_of
FROM public.muse_domains d
WHERE d.is_active;

COMMENT ON VIEW public.muse_portfolio_map IS
  'One row per domain: status, owner, systems, source of truth, primary KPI, bottleneck, initiative, next review, and live counts.';

-- ===========================================================================
-- 20. EXECUTIVE BRIEF
-- ===========================================================================
-- Single query behind both the Hub UI and /executive/brief. Sections are
-- derived; nothing is hand-ranked.
CREATE OR REPLACE VIEW public.muse_executive_brief AS
WITH items AS (
  -- Top priorities: P0/P1 loops that are still real.
  SELECT 'priorities'::text AS section, l.priority AS sort_a,
         coalesce(l.review_at, l.last_evidence_at, now() + interval '100 years') AS sort_b,
         l.title, l.domain_key, l.domain_name,
         coalesce(l.next_action, l.dependency, 'No next action recorded') AS detail,
         l.classification, l.owner, l.review_at AS due_at,
         l.source, l.source_ref, l.data_status, l.verification_state,
         l.id::text AS item_id, 'open_loop'::text AS item_type
  FROM public.muse_open_loops_live l
  WHERE l.state NOT IN ('RESOLVED','CANCELLED') AND l.priority IN ('P0','P1')

  UNION ALL
  SELECT 'decisions_required', CASE WHEN dr.overdue THEN 'P0' ELSE 'P1' END,
         coalesce(dr.decision_required_by, now() + interval '100 years'),
         dr.question, dr.domain_key, dr.domain_name,
         coalesce(dr.context, 'No context recorded'),
         dr.classification, dr.owner, dr.decision_required_by,
         dr.source, dr.source_ref, 'KNOWN', 'CLAIMED',
         dr.id::text, 'decision'
  FROM public.muse_decisions_required dr

  UNION ALL
  SELECT 'blockers', l.priority,
         coalesce(l.review_at, now() + interval '100 years'),
         l.title, l.domain_key, l.domain_name,
         coalesce(l.dependency, 'Blocker not described'),
         l.classification, l.owner, l.review_at,
         l.source, l.source_ref, l.data_status, l.verification_state,
         l.id::text, 'open_loop'
  FROM public.muse_open_loops_live l
  WHERE l.state = 'BLOCKED'

  UNION ALL
  SELECT 'waiting', l.priority,
         coalesce(l.review_at, now() + interval '100 years'),
         l.title, l.domain_key, l.domain_name,
         coalesce(l.dependency, 'Waiting on an external party'),
         'WAITING', l.owner, l.review_at,
         l.source, l.source_ref, l.data_status, l.verification_state,
         l.id::text, 'open_loop'
  FROM public.muse_open_loops_live l
  WHERE l.state = 'WAITING'

  UNION ALL
  -- Queues that are explicitly waiting on a human decision.
  SELECT 'waiting', 'P1',
         coalesce(h.latest_activity_at, now()),
         h.name || ': ' || h.pending_count || ' item(s) awaiting a human',
         h.domain_key, coalesce(dm.name, h.domain_key),
         coalesce(h.downstream_impact, 'Queue stalls until reviewed'),
         'FENDI_DECISION', 'Fendi', NULL::timestamptz,
         h.probe_key, h.system_key, h.data_status, 'SYSTEM_VERIFIED',
         h.system_key, 'system'
  FROM public.muse_system_health h
  LEFT JOIN public.muse_domains dm ON dm.key = h.domain_key
  WHERE h.waits_on_human AND h.pending_count > 0

  UNION ALL
  SELECT 'financial', l.priority,
         coalesce(l.review_at, now() + interval '100 years'),
         l.title, l.domain_key, l.domain_name,
         coalesce(l.next_action, 'No next action recorded'),
         l.classification, l.owner, l.review_at,
         l.source, l.source_ref, l.data_status, l.verification_state,
         l.id::text, 'open_loop'
  FROM public.muse_open_loops_live l
  WHERE l.category = 'FINANCIAL' AND l.state NOT IN ('RESOLVED','CANCELLED')

  UNION ALL
  SELECT 'system_failures',
         CASE WHEN h.status = 'FAILING' THEN 'P0' ELSE 'P1' END,
         coalesce(h.last_failure_at, h.latest_activity_at, now()),
         h.name || ' — ' || h.status, h.domain_key, coalesce(dm.name, h.domain_key),
         coalesce(h.last_failure_detail, h.blocker,
                  'No successful run within twice the expected cadence'),
         h.classification, 'Fendi', NULL::timestamptz,
         h.probe_key, h.system_key, h.data_status, 'SYSTEM_VERIFIED',
         h.system_key, 'system'
  FROM public.muse_system_health h
  LEFT JOIN public.muse_domains dm ON dm.key = h.domain_key
  WHERE h.status IN ('FAILING','STALE')

  UNION ALL
  SELECT 'opportunities', l.priority,
         coalesce(l.review_at, now() + interval '100 years'),
         l.title, l.domain_key, l.domain_name,
         coalesce(l.next_action, 'No next action recorded'),
         l.classification, l.owner, l.review_at,
         l.source, l.source_ref, l.data_status, l.verification_state,
         l.id::text, 'open_loop'
  FROM public.muse_open_loops_live l
  WHERE l.category = 'OPPORTUNITY' AND l.state NOT IN ('RESOLVED','CANCELLED')

  UNION ALL
  SELECT 'commitments', l.priority,
         coalesce(l.review_at, now() + interval '100 years'),
         l.title, l.domain_key, l.domain_name,
         coalesce(l.next_action, 'Commitment has no next action recorded'),
         l.classification, l.owner, l.review_at,
         l.source, l.source_ref, l.data_status, l.verification_state,
         l.id::text, 'open_loop'
  FROM public.muse_open_loops_live l
  WHERE l.category = 'COMMITMENT' AND l.state NOT IN ('RESOLVED','CANCELLED')
)
SELECT
  section,
  row_number() OVER (PARTITION BY section ORDER BY sort_a, sort_b, title) AS rank,
  item_type,
  item_id,
  title,
  domain_key,
  domain_name,
  detail,
  classification,
  owner,
  due_at,
  source,
  source_ref,
  data_status,
  verification_state,
  now() AS as_of
FROM items;

COMMENT ON VIEW public.muse_executive_brief IS
  'Ranked executive brief: priorities, decisions required, blockers, waiting, financial, system failures, opportunities, commitments.';

-- ===========================================================================
-- 21. PRIVILEGES — the read-only boundary
-- ===========================================================================
-- Supabase's default privileges grant `anon` on new objects in `public`, so
-- every Muse object revokes it explicitly. Nothing in Muse is public.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname LIKE 'muse\_%' AND c.relkind IN ('r','v','p')
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', r.relname);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', r.relname);

    IF r.relkind = 'v' THEN
      -- Curated read surfaces: readable by the signed-in operator, the
      -- service role (edge functions) and the dedicated reader role.
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', r.relname);
    ELSE
      -- Registry tables stay RLS-guarded; privileges mirror existing Hub tables.
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', r.relname);
      EXECUTE format('GRANT ALL ON public.%I TO service_role', r.relname);
    END IF;
  END LOOP;
END $$;

-- Token material and audit trail: the browser role gets no access to tokens at
-- all, and read-only access to the audit trail.
REVOKE ALL ON public.muse_api_tokens FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.muse_access_audit FROM authenticated;
GRANT SELECT ON public.muse_access_audit TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.muse_access_audit_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.muse_access_audit_id_seq FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- `muse_reader`: least-privilege database role for any future direct-SQL
-- consumer (e.g. a PostgREST JWT minted with `role: muse_reader`). It can
-- SELECT the curated views and nothing else — no base tables, no registry
-- tables, no token material, no write privilege anywhere.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'muse_reader') THEN
    CREATE ROLE muse_reader NOLOGIN NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO muse_reader;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname LIKE 'muse\_%' AND c.relkind = 'v'
  LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO muse_reader', r.relname);
  END LOOP;
END $$;

-- Let PostgREST switch into the role when a muse_reader JWT is presented.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    EXECUTE 'GRANT muse_reader TO authenticator';
  END IF;
END $$;

-- NOTE: default privileges for the whole `public` schema are deliberately left
-- untouched. Changing them would alter how every FUTURE Lovable-generated table
-- behaves, which is outside Muse's boundary. New muse_* objects must instead
-- repeat the explicit REVOKE above.

-- ===========================================================================
-- 22. SEED — portfolio spine
-- ===========================================================================
-- Every seeded row is either (a) structural (the domain exists because Fendi
-- named it) or (b) evidenced by something verifiable in this repository / the
-- live generated schema. No KPI value, status or metric is invented: where the
-- data is not reachable the row says so.
INSERT INTO public.muse_domains
  (key, name, owner, status, systems, source_of_truth, current_bottleneck, current_initiative, data_status, sort_order, notes)
VALUES
  ('boltz_automotive', 'Boltz Automotive', 'Fendi', 'UNKNOWN',
   '["boltz-insight-engine","ringcentral","meta-lead-ads","grok-agent"]'::jsonb,
   'Boltz Insight Engine (Supabase smrbsnnisvmubbwfhafy)',
   'Operational truth is not reachable from Control Hub yet',
   'Connect Boltz Insight Engine to Muse read layer',
   'SOURCE_EXISTS_ACCESS_NEEDED', 10,
   'Boltz Insight Engine owns leads, message_threads, messages, escalations, agent_runs, meta_lead_submissions, ringcentral_subscriptions and integration_health_snapshots. Separate Supabase project, so Control Hub cannot build views over it.'),

  ('modest_streetwear', 'Modest Streetwear', 'Fendi', 'UNKNOWN', '[]'::jsonb,
   NULL, 'No system of record identified', 'Identify systems of record',
   'UNKNOWN', 20,
   'Hub links to an external Modest Streetwear product via VITE_HUB_MODEST_STREETWEAR_URL; no data source is connected.'),

  ('fendi_frost_music', 'Fendi Frost / Music', 'Fendi', 'UNKNOWN',
   '["artist-growth-hub","playlist-research","pitch-drafts"]'::jsonb,
   'FanFuel / Artist Growth Hub (external)',
   'Music truth is split between AGH and Control Hub pitch tables',
   'Establish AGH as authoritative music source',
   'NEEDS_VERIFICATION', 30,
   'Control Hub holds playlist_research and pitch_drafts locally; AGH holds campaign truth. Split ownership is itself an open question.'),

  ('the_workhouse', 'The Workhouse', 'Fendi', 'UNKNOWN', '[]'::jsonb,
   NULL, 'No system of record identified', 'Identify systems of record',
   'UNKNOWN', 40, 'No Control Hub data found for this domain.'),

  ('community_nonprofit', 'Nonprofit / Community', 'Fendi', 'UNKNOWN', '[]'::jsonb,
   NULL, 'No system of record identified', 'Identify systems of record',
   'UNKNOWN', 50, 'No Control Hub data found for this domain.'),

  ('personal_exec_ops', 'Personal Executive Operations', 'Fendi', 'UNKNOWN',
   '["telegram-bot","remote-mac-bridge"]'::jsonb,
   NULL, 'Calendar/email/commitments not connected to Muse',
   'Decide which personal systems Muse may observe',
   'SOURCE_EXISTS_ACCESS_NEEDED', 60,
   'Telegram and the Remote Mac bridge are observable; calendar and mail are not connected.'),

  ('ai_technical_systems', 'AI / Technical Systems', 'Fendi', 'KNOWN',
   '["control-hub","supabase-edge-functions","github","claude-code","cursor","telegram-bot","remote-mac-bridge"]'::jsonb,
   'GitHub (code/schema) + Control Hub Supabase (runtime state)',
   'Deployment state is not machine-readable: a commit does not prove a deploy',
   'Muse v1 executive layer inside Control Hub',
   'KNOWN', 70,
   'The only domain whose operational truth is fully inside Control Hub today.'),

  ('tax_credit_services', 'Tax & Credit Services', 'Fendi', 'KNOWN',
   '["tax-generator","credit-guardian","credit-compass","drive-sync","statement-pipeline"]'::jsonb,
   'Control Hub Supabase (wkzwcfmvnwolgrdpnygc)',
   'Portfolio ownership of this domain is unconfirmed',
   'Confirm whether this is its own domain or part of The Workhouse',
   'NEEDS_VERIFICATION', 80,
   'This domain was NOT in the portfolio list Fendi gave, but it is the largest live dataset in Control Hub (clients, tax_returns, documents, dispute_letters). Mapped provisionally and flagged for confirmation rather than dropped or silently merged.')
ON CONFLICT (key) DO NOTHING;

-- ===========================================================================
-- 23. SEED — system / agent registry
-- ===========================================================================
-- probe_key is set only where Control Hub actually owns telemetry. Cadence is
-- left NULL where the schedule is not verifiable from this repository: an
-- invented cadence would produce invented staleness.
INSERT INTO public.muse_systems
  (key, name, role, domain_key, expected_cadence, cadence_minutes, probe_key, owner_type, waits_on_human, downstream_impact, data_status, sort_order, blocker, notes)
VALUES
  ('drive-sync', 'Drive Sync', 'Pulls client documents from Google Drive into Control Hub',
   'tax_credit_services', 'unverified (cron not declared in repo)', NULL, 'drive_sync', 'AUTOMATED_SYSTEM', false,
   'New client documents never reach ingestion or the tax/credit workflows', 'NEEDS_VERIFICATION', 10, NULL,
   'Telemetry: public.drive_sync_runs. Cadence must be confirmed in Lovable before staleness can be detected.'),

  ('ingestion-jobs', 'Document Ingestion Workers', 'OCR and field extraction for queued documents',
   'tax_credit_services', 'event driven (queue)', NULL, 'ingestion_jobs', 'AUTOMATED_SYSTEM', false,
   'Observations and tradelines go stale; credit analysis works from old documents', 'KNOWN', 20, NULL,
   'Telemetry: public.ingestion_jobs (last_error, completed_at).'),

  ('statement-chunk-jobs', 'Statement Chunk Pipeline', 'Parses financial statements into transactions',
   'tax_credit_services', 'event driven (queue)', NULL, 'statement_chunk_jobs', 'AUTOMATED_SYSTEM', false,
   'Tax worksheets cannot be built from client statements', 'KNOWN', 30, NULL,
   'Telemetry: public.statement_chunk_jobs (last_error, prep_error).'),

  ('telegram-webhook', 'Telegram Webhook', 'Inbound operator commands into Control Hub',
   'personal_exec_ops', 'event driven (inbound)', NULL, 'telegram_webhook', 'AUTOMATED_SYSTEM', false,
   'Fendi cannot drive Control Hub from chat', 'KNOWN', 40, NULL,
   'Telemetry: public.telegram_webhook_processed_updates (accepted updates only — silence is not failure).'),

  ('telegram-outbox', 'Telegram Outbox', 'Outbound replies and notifications',
   'personal_exec_ops', 'event driven (queue)', NULL, 'telegram_outbox', 'AUTOMATED_SYSTEM', false,
   'Fendi stops receiving answers and alerts', 'KNOWN', 50, NULL,
   'Telemetry: public.telegram_outbox (sent_at, last_error).'),

  ('guardian-queue', 'Credit Guardian Event Queue', 'Relays guardian events to Credit Guardian',
   'tax_credit_services', 'event driven (queue)', NULL, 'guardian_queue', 'AUTOMATED_SYSTEM', false,
   'Dispute rounds are not advanced by observed bureau responses', 'KNOWN', 60, NULL,
   'Telemetry: public.pending_guardian_events (status, delivery_error).'),

  ('workflow-runner', 'Workflow Runner', 'Executes multi-stage Control Hub workflows',
   'ai_technical_systems', 'event driven', NULL, 'workflow_runner', 'AUTOMATED_SYSTEM', false,
   'Multi-step client work stalls mid-stage', 'KNOWN', 70, NULL,
   'Telemetry: public.workflow_runs (status, error, last_error).'),

  ('remote-bridge', 'Remote Mac Bridge', 'Runs shell, Cursor and Claude commands on the Mac',
   'ai_technical_systems', 'heartbeat', 30, 'remote_bridge_device', 'DELEGATE_TO_AGENT', false,
   'Queued commands are never executed; remote development stops', 'KNOWN', 80, NULL,
   'Telemetry: public.remote_bridge_devices.last_seen_at. 30 min is the heartbeat assumption used for staleness — confirm against the daemon.'),

  ('remote-command-queue', 'Remote Command Queue', 'Queue feeding the Mac bridge',
   'ai_technical_systems', 'event driven (queue)', NULL, 'remote_command_queue', 'AUTOMATED_SYSTEM', false,
   'Commands expire unclaimed after 24h', 'KNOWN', 90, NULL,
   'Telemetry: public.remote_command_queue (status, error, expires_at).'),

  ('cc-tool-executor', 'Control Hub Tool Executor', 'Runs AI tool calls for the operator bot',
   'ai_technical_systems', 'event driven', NULL, 'cc_tool_executor', 'DELEGATE_TO_AGENT', false,
   'Operator requests silently fail or return wrong results', 'KNOWN', 100, NULL,
   'Telemetry: public.tool_execution_logs (status attempted/succeeded/failed, model).'),

  ('agent-task-loop', 'Agent Task Loop', 'Session tasks raised from chat surfaces',
   'ai_technical_systems', 'event driven', NULL, 'agent_task_loop', 'DELEGATE_TO_AGENT', false,
   'Requests are accepted but never completed', 'KNOWN', 110, NULL,
   'Telemetry: public.tasks (status, error).'),

  ('approval-queue', 'Observation Approval Queue', 'Human approval of extracted observations',
   'tax_credit_services', 'waits on Fendi', NULL, 'telegram_approval_queue', 'FENDI_DECISION', true,
   'Extracted observations are not promoted until reviewed', 'KNOWN', 120, NULL,
   'Telemetry: public.telegram_approval_queue. pending_count is work waiting on a human, not a fault.'),

  -- Systems that exist and matter but whose telemetry Control Hub cannot read.
  ('boltz-insight-engine', 'Boltz Insight Engine', 'Lead, message and escalation operations for Boltz',
   'boltz_automotive', 'unknown', NULL, NULL, 'AUTOMATED_SYSTEM', false,
   'Muse cannot see Boltz lead flow, escalations or agent decisions', 'SOURCE_EXISTS_ACCESS_NEEDED', 200, 'No read credential for Supabase smrbsnnisvmubbwfhafy',
   'Owns leads, message_threads, messages, message_jobs, escalations, agent_runs. Health would come from integration_health_snapshots.'),

  ('boltz-ringcentral', 'RingCentral SMS Webhook', 'Inbound/outbound SMS for Boltz leads',
   'boltz_automotive', 'subscription renewal', NULL, NULL, 'AUTOMATED_SYSTEM', false,
   'Lead conversations stop; an expired subscription silently drops inbound SMS', 'SOURCE_EXISTS_ACCESS_NEEDED', 210, 'Not reachable from Control Hub',
   'Boltz owns ringcentral_subscriptions (expires_at, last_renewal_error) — the natural health signal once connected.'),

  ('boltz-meta-leads', 'Meta Lead Ingestion', 'Facebook/Instagram lead-ad intake for Boltz',
   'boltz_automotive', 'event driven (webhook)', NULL, NULL, 'AUTOMATED_SYSTEM', false,
   'Paid leads are never worked', 'SOURCE_EXISTS_ACCESS_NEEDED', 220, 'Not reachable from Control Hub',
   'Boltz owns meta_lead_submissions (ingest_status, last_error).'),

  ('boltz-grok-agent', 'Grok Bot', 'Drafts and triages Boltz lead replies',
   'boltz_automotive', 'event driven', NULL, NULL, 'DELEGATE_TO_AGENT', false,
   'Leads wait for a human or get no reply', 'SOURCE_EXISTS_ACCESS_NEEDED', 230, 'Not reachable from Control Hub',
   'Boltz owns agent_runs (model, action, escalation_category) and escalations.'),

  ('agh-fanfuel', 'FanFuel / Artist Growth Hub', 'Music campaign and audience operations',
   'fendi_frost_music', 'unknown', NULL, NULL, 'AUTOMATED_SYSTEM', false,
   'Music performance cannot be reviewed in the portfolio', 'SOURCE_EXISTS_ACCESS_NEEDED', 240, 'No read credential',
   'External product; Control Hub only holds local playlist_research and pitch_drafts.'),

  ('github-repos', 'GitHub', 'Source of truth for code and schema',
   'ai_technical_systems', 'per push', NULL, NULL, 'AUTOMATED_SYSTEM', false,
   'Muse cannot distinguish coded from deployed', 'SOURCE_EXISTS_ACCESS_NEEDED', 250, 'No read token configured for the Muse layer',
   'Repos: fendifrost-dot/fendi-control-center, ai-video-tool, boltz-insight-engine. Commit presence never implies deployment.'),

  ('lovable-deploys', 'Lovable Publish / Edge Redeploy', 'Makes code live (frontend publish, edge redeploy)',
   'ai_technical_systems', 'manual', NULL, NULL, 'HUMAN_OWNER', false,
   'Verified-live status cannot be established automatically', 'SOURCE_EXISTS_ACCESS_NEEDED', 260, 'Lovable exposes no machine-readable deploy state to Muse',
   'This gap is why muse_verifications separates CLAIMED/ARTIFACT_VERIFIED/SYSTEM_VERIFIED/LIVE_VERIFIED.'),

  ('claude-code', 'Claude Code', 'Implementation agent (code, migrations, docs)',
   'ai_technical_systems', 'on request', NULL, NULL, 'DELEGATE_TO_AGENT', false,
   'Work is claimed but not verified', 'SOURCE_EXISTS_ACCESS_NEEDED', 270, 'No execution telemetry written to Control Hub',
   'Claims land in muse_verifications as CLAIMED until a system or live check promotes them.'),

  ('cursor-workflows', 'Cursor-driven workflows', 'Implementation agent on the Mac',
   'ai_technical_systems', 'on request', NULL, NULL, 'DELEGATE_TO_AGENT', false,
   'Same as Claude Code: claims without verification', 'SOURCE_EXISTS_ACCESS_NEEDED', 280, 'Only visible indirectly via remote_command_queue',
   'Partially observable: commands of type cursor_agent appear in public.remote_command_queue.')
ON CONFLICT (key) DO NOTHING;

-- ===========================================================================
-- 24. SEED — source authority register
-- ===========================================================================
INSERT INTO public.muse_source_authority
  (domain_key, subject, authoritative_system, secondary_system, access_status,
   freshness_target_minutes, last_verified_at, confidence, known_conflict, reference, notes)
VALUES
  ('ai_technical_systems', 'Code and schema',
   'GitHub: fendifrost-dot/fendi-control-center', 'Lovable project 7fce9fc6-fd96-4a31-8a89-649f00298c51',
   'KNOWN', 1440, now(), 'HIGH', true,
   'https://github.com/fendifrost-dot/fendi-control-center',
   'Conflict recorded: a migration present in GitHub is absent from the live generated schema. See muse_source_conflicts.'),

  ('ai_technical_systems', 'Deployed / live state',
   'Lovable (Publish + Edge Functions redeploy)', 'GitHub main',
   'SOURCE_EXISTS_ACCESS_NEEDED', 60, NULL, 'LOW', false,
   'Lovable project 7fce9fc6-fd96-4a31-8a89-649f00298c51',
   'No machine-readable deploy state. Live status must be asserted by a probe or a human, never inferred from a commit.'),

  ('ai_technical_systems', 'Control Hub runtime state',
   'Control Hub Supabase (wkzwcfmvnwolgrdpnygc)', NULL,
   'KNOWN', 15, now(), 'HIGH', false,
   'public.* operational tables',
   'Read live through muse_system_probe; Muse stores no copy.'),

  ('tax_credit_services', 'Client, return and document records',
   'Control Hub Supabase (wkzwcfmvnwolgrdpnygc)', 'Google Drive (source files)',
   'KNOWN', 60, now(), 'HIGH', false,
   'public.clients, public.tax_returns, public.documents',
   'Drive holds the original artifacts; the database holds the working truth.'),

  ('boltz_automotive', 'Leads, conversations and escalations',
   'Boltz Insight Engine (Supabase smrbsnnisvmubbwfhafy)', 'RingCentral / Meta Lead Ads',
   'SOURCE_EXISTS_ACCESS_NEEDED', 30, NULL, 'LOW', false,
   'https://github.com/fendifrost-dot/boltz-insight-engine',
   'Schema verified by reading the repo: leads, message_threads, messages, escalations, agent_runs, integration_health_snapshots.'),

  ('boltz_automotive', 'Revenue and job profitability',
   'UNKNOWN', NULL, 'UNKNOWN', NULL, NULL, 'LOW', false, NULL,
   'No revenue system identified. Open decision: which system is authoritative.'),

  ('fendi_frost_music', 'Campaign and audience performance',
   'FanFuel / Artist Growth Hub', 'Control Hub playlist_research + pitch_drafts',
   'SOURCE_EXISTS_ACCESS_NEEDED', 1440, NULL, 'LOW', false,
   'VITE_HUB_ARTIST_HUB_URL',
   'Control Hub holds pitch/research rows locally, which is a second copy of part of this truth — ownership needs a decision.'),

  ('fendi_frost_music', 'Media generation (video/image)',
   'AI Video Tool (Supabase qoyxgnkvjukovkrvdaiq)', 'Control Hub provider proxy',
   'AVAILABLE_NOT_CONNECTED', 1440, NULL, 'LOW', false,
   'CLAUDE.md — sister project',
   'Control Hub proxies Fal/provider calls for AVT but does not own the job records.'),

  ('modest_streetwear', 'Sales and inventory',
   'UNKNOWN', NULL, 'UNKNOWN', NULL, NULL, 'LOW', false, 'VITE_HUB_MODEST_STREETWEAR_URL',
   'Only an external product link exists in the Hub; no data source identified.'),

  ('the_workhouse', 'Operations', 'UNKNOWN', NULL, 'UNKNOWN', NULL, NULL, 'LOW', false, NULL,
   'No system of record identified in Control Hub.'),

  ('community_nonprofit', 'Programs and donors', 'UNKNOWN', NULL, 'UNKNOWN', NULL, NULL, 'LOW', false, NULL,
   'No system of record identified in Control Hub.'),

  ('personal_exec_ops', 'Commitments, calendar and mail',
   'Google Workspace', 'Telegram history',
   'SOURCE_EXISTS_ACCESS_NEEDED', 60, NULL, 'LOW', false, NULL,
   'Not connected to Muse. Requires an explicit decision about what Muse may observe.'),

  ('ai_technical_systems', 'AI provider spend',
   'Provider dashboards (Fal and others)', 'Control Hub tool_execution_logs',
   'SOURCE_EXISTS_ACCESS_NEEDED', 1440, NULL, 'LOW', false,
   'FAL_KEY held in Lovable Cloud',
   'Control Hub logs call counts and failures but not cost; spend truth stays with the provider.')
ON CONFLICT (domain_key, subject) DO NOTHING;

-- ===========================================================================
-- 25. SEED — source conflict (evidenced, not invented)
-- ===========================================================================
-- GitHub carries a migration and edge-function code for a table that the live
-- generated schema does not contain. Muse records both sides and proposes an
-- authority; it does not decide.
INSERT INTO public.muse_source_conflicts
  (domain_key, subject, system_a, value_a, reference_a, system_b, value_b, reference_b,
   candidate_authority, status, resolution_notes)
SELECT
  'ai_technical_systems',
  'Existence of table public.pending_route_clarifications',
  'GitHub (fendi-control-center @ main)',
  'Table is created by a migration and referenced by the telegram-webhook function',
  'supabase/migrations/20260424_pending_route_clarifications.sql; supabase/functions/telegram-webhook/index.ts',
  'Live Control Hub schema (wkzwcfmvnwolgrdpnygc)',
  'Table is absent from the generated schema mirror',
  'src/integrations/supabase/types.ts',
  'Live Supabase schema — GitHub proves the migration exists, only the runtime proves it was applied',
  'OPEN',
  'Either the migration was never applied in the Lovable SQL editor, or the generated types are stale. Resolve by querying the live schema, not by trusting either file.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.muse_source_conflicts
  WHERE subject = 'Existence of table public.pending_route_clarifications'
);

-- ===========================================================================
-- 26. SEED — KPI registry
-- ===========================================================================
INSERT INTO public.muse_kpi_registry
  (metric_key, domain_key, name, unit, direction, source_system, is_derived, data_status, is_primary, sort_order, notes)
VALUES
  -- Derivable today from data Control Hub owns.
  ('cc.tax_returns_open', 'tax_credit_services', 'Open tax returns', 'count', 'DOWN_IS_GOOD',
   'Control Hub Supabase', true, 'KNOWN', true, 10, 'public.tax_returns where status <> filed.'),
  ('cc.tax_returns_filed_ytd', 'tax_credit_services', 'Returns filed YTD', 'count', 'UP_IS_GOOD',
   'Control Hub Supabase', true, 'KNOWN', false, 20, 'public.tax_returns.filed_at within the current year.'),
  ('cc.clients_total', 'tax_credit_services', 'Clients on record', 'count', 'UP_IS_GOOD',
   'Control Hub Supabase', true, 'KNOWN', false, 30, 'public.clients.'),
  ('cc.dispute_letters_30d', 'tax_credit_services', 'Dispute letters (30d)', 'count', 'UP_IS_GOOD',
   'Control Hub Supabase', true, 'KNOWN', false, 40, 'public.dispute_letters.'),
  ('cc.marketing_spend_30d', 'tax_credit_services', 'Ad spend (30d)', 'USD', 'DOWN_IS_GOOD',
   'Control Hub Supabase (Meta sync)', true, 'NEEDS_VERIFICATION', false, 50,
   'public.marketing_spend. Which domain owns this spend is unconfirmed — it is attributed here provisionally.'),
  ('cc.marketing_conversions_30d', 'tax_credit_services', 'Ad conversions (30d)', 'count', 'UP_IS_GOOD',
   'Control Hub Supabase (Meta sync)', true, 'NEEDS_VERIFICATION', false, 60, 'public.marketing_spend.'),
  ('music.pitch_drafts_30d', 'fendi_frost_music', 'Pitch drafts created (30d)', 'count', 'UP_IS_GOOD',
   'Control Hub Supabase', true, 'KNOWN', true, 10, 'public.pitch_drafts. Activity, not outcome.'),
  ('music.playlist_research_30d', 'fendi_frost_music', 'Playlist research runs (30d)', 'count', 'UP_IS_GOOD',
   'Control Hub Supabase', true, 'KNOWN', false, 20, 'public.playlist_research.'),
  ('ai.tool_calls_7d', 'ai_technical_systems', 'AI tool calls (7d)', 'count', 'NEUTRAL',
   'Control Hub Supabase', true, 'KNOWN', false, 20, 'public.tool_execution_logs.'),
  ('ai.tool_failures_7d', 'ai_technical_systems', 'AI tool failures (7d)', 'count', 'DOWN_IS_GOOD',
   'Control Hub Supabase', true, 'KNOWN', true, 10, 'public.tool_execution_logs where status = failed.'),
  ('ai.approvals_pending', 'ai_technical_systems', 'Approvals waiting on Fendi', 'count', 'DOWN_IS_GOOD',
   'Control Hub Supabase', true, 'KNOWN', false, 30, 'public.telegram_approval_queue where status = pending.'),

  -- Declared because they matter, explicitly not measured yet.
  ('boltz.leads_30d', 'boltz_automotive', 'New leads (30d)', 'count', 'UP_IS_GOOD',
   'Boltz Insight Engine', false, 'SOURCE_EXISTS_ACCESS_NEEDED', true, 10,
   'Boltz owns public.leads; no read access from Control Hub.'),
  ('boltz.escalations_open', 'boltz_automotive', 'Open escalations', 'count', 'DOWN_IS_GOOD',
   'Boltz Insight Engine', false, 'SOURCE_EXISTS_ACCESS_NEEDED', false, 20,
   'Boltz owns public.escalations.'),
  ('boltz.revenue_30d', 'boltz_automotive', 'Revenue (30d)', 'USD', 'UP_IS_GOOD',
   'UNKNOWN', false, 'UNKNOWN', false, 30, 'No revenue system identified.'),
  ('modest.revenue_30d', 'modest_streetwear', 'Revenue (30d)', 'USD', 'UP_IS_GOOD',
   'UNKNOWN', false, 'UNKNOWN', true, 10, 'No system of record identified.'),
  ('music.streams_30d', 'fendi_frost_music', 'Streams (30d)', 'count', 'UP_IS_GOOD',
   'FanFuel / Artist Growth Hub', false, 'SOURCE_EXISTS_ACCESS_NEEDED', false, 30,
   'Outcome metric; requires AGH access.'),
  ('workhouse.primary', 'the_workhouse', 'Primary metric (undefined)', 'count', 'NEUTRAL',
   'UNKNOWN', false, 'NOT_MEASURED', true, 10, 'Metric not yet defined for this domain.'),
  ('community.primary', 'community_nonprofit', 'Primary metric (undefined)', 'count', 'NEUTRAL',
   'UNKNOWN', false, 'NOT_MEASURED', true, 10, 'Metric not yet defined for this domain.'),
  ('personal.commitments_open', 'personal_exec_ops', 'Open commitments', 'count', 'DOWN_IS_GOOD',
   'Google Workspace', false, 'SOURCE_EXISTS_ACCESS_NEEDED', true, 10,
   'Calendar and mail are not connected to Muse.')
ON CONFLICT (metric_key) DO NOTHING;

-- ===========================================================================
-- 27. SEED — open loops
-- ===========================================================================
-- These are the real, verifiable loops this build produced or uncovered. No
-- business content is invented: Muse starts by admitting what it cannot see.
INSERT INTO public.muse_open_loops
  (domain_key, title, owner, state, classification, category, priority, dependency,
   source, source_ref, last_evidence_at, next_action, review_at, verification_state,
   derive_resolution_from, notes)
SELECT v.* FROM (VALUES
  ('ai_technical_systems',
   'Muse v1: apply migration in Lovable SQL editor and redeploy muse-executive',
   'Fendi', 'IN_PROGRESS', 'HUMAN_OWNER', 'SYSTEM', 'P0',
   'Lovable SQL editor (schema) + Lovable Edge Functions redeploy (API)',
   'muse_v1_build', 'supabase/migrations/20260925120000_muse_executive_layer.sql',
   now(),
   'Paste this migration into the Lovable SQL editor, then redeploy the muse-executive edge function, then run scripts/muse/verify-muse-live.mjs',
   now() + interval '2 days', 'CLAIMED', NULL,
   'Code exists in GitHub. That is CODED, not LIVE. This loop closes only when the live verification script passes.'),

  ('boltz_automotive',
   'Connect Boltz Insight Engine to the Muse read layer',
   'Fendi', 'BLOCKED', 'FENDI_DECISION', 'SYSTEM', 'P1',
   'A read-only credential for Supabase smrbsnnisvmubbwfhafy and muse_reader-style read views in that project',
   'muse_v1_build', 'https://github.com/fendifrost-dot/boltz-insight-engine',
   now(),
   'Pick the credential model in the decision register, then apply the Boltz-side read grants',
   now() + interval '7 days', 'CLAIMED', NULL,
   'Boltz is the largest unobserved domain. Its schema is known; only access is missing.'),

  ('fendi_frost_music',
   'Connect FanFuel / Artist Growth Hub as the music source of truth',
   'Fendi', 'BLOCKED', 'FENDI_DECISION', 'SYSTEM', 'P2',
   'Read access to AGH data',
   'muse_v1_build', 'VITE_HUB_ARTIST_HUB_URL',
   now(),
   'Confirm which AGH instance is authoritative and whether it can expose a read surface',
   now() + interval '14 days', 'CLAIMED', NULL, NULL),

  ('fendi_frost_music',
   'Resolve duplicated music truth between AGH and Control Hub pitch tables',
   'Fendi', 'OPEN', 'FENDI_DECISION', 'RISK', 'P2',
   'Outcome of the AGH connection loop',
   'muse_v1_build', 'public.pitch_drafts, public.playlist_research',
   now(),
   'Decide whether Control Hub pitch/research tables are authoritative or a working copy',
   now() + interval '14 days', 'CLAIMED', NULL,
   'Control Hub currently holds music rows locally while AGH is named as the source of truth. Muse flags this rather than picking.'),

  ('tax_credit_services',
   'Confirm portfolio ownership of Tax & Credit Services',
   'Fendi', 'WAITING', 'FENDI_DECISION', 'OPERATIONAL', 'P2',
   'A decision from Fendi',
   'muse_v1_build', 'muse_domains.tax_credit_services',
   now(),
   'Confirm whether this is its own domain or part of The Workhouse',
   now() + interval '7 days', 'CLAIMED', NULL,
   'This domain was not in the portfolio list but is the largest live dataset in Control Hub. Mapped provisionally and flagged.'),

  ('ai_technical_systems',
   'Record the real cadence of Control Hub background workers',
   'Fendi', 'OPEN', 'DELEGATE_TO_AGENT', 'SYSTEM', 'P2',
   'Lovable cron configuration is not visible in the repository',
   'muse_v1_build', 'public.muse_systems.cadence_minutes',
   now(),
   'Confirm each worker schedule in Lovable and set cadence_minutes so staleness becomes detectable',
   now() + interval '14 days', 'CLAIMED', NULL,
   'Until cadence is known, Muse can report FAILING but not STALE for most workers. An invented cadence would produce invented alarms.'),

  ('ai_technical_systems',
   'Resolve the pending_route_clarifications schema conflict',
   'Fendi', 'OPEN', 'DELEGATE_TO_AGENT', 'RISK', 'P1',
   'A query against the live schema',
   'muse_v1_build', 'muse_source_conflicts',
   now(),
   'Check the live schema; either apply the missing migration or regenerate the stale types file',
   now() + interval '7 days', 'CLAIMED', NULL,
   'telegram-webhook references a table the generated schema does not contain — a live 42P01 risk if that code path runs.'),

  ('ai_technical_systems',
   'Establish machine-readable deploy verification (CODED to LIVE_VERIFIED)',
   'Fendi', 'OPEN', 'MUSE_ANALYSIS', 'SYSTEM', 'P2',
   'Lovable exposes no deploy state to Muse',
   'muse_v1_build', 'public.muse_verifications',
   now(),
   'Add a live probe per surface (version endpoint or health check) that Muse can call to promote CLAIMED to LIVE_VERIFIED',
   now() + interval '30 days', 'CLAIMED', NULL, NULL),

  ('tax_credit_services',
   'Confirm Drive Sync has completed a successful run since Muse went live',
   'Fendi', 'OPEN', 'AUTOMATED_SYSTEM', 'SYSTEM', 'P2',
   'drive-sync telemetry',
   'muse_v1_build', 'public.drive_sync_runs',
   now(), 'None — this loop closes itself when the drive-sync probe reports healthy',
   now() + interval '7 days', 'CLAIMED', 'drive-sync',
   'Demonstrates derived resolution: state comes from the authoritative system, not from anyone remembering to close the row.'),

  ('personal_exec_ops',
   'Decide which personal systems Muse may observe',
   'Fendi', 'OPEN', 'FENDI_DECISION', 'OPERATIONAL', 'P2',
   'A decision from Fendi',
   'muse_v1_build', 'muse_source_authority',
   now(), 'Decide whether calendar and mail are in scope for Muse observation',
   now() + interval '30 days', 'CLAIMED', NULL, NULL),

  ('modest_streetwear',
   'Identify the Modest Streetwear system of record',
   'Fendi', 'OPEN', 'FENDI_DECISION', 'OPERATIONAL', 'P3',
   'A decision from Fendi',
   'muse_v1_build', 'VITE_HUB_MODEST_STREETWEAR_URL',
   now(), 'Name the storefront/inventory system so Muse can register an authority',
   now() + interval '30 days', 'CLAIMED', NULL, NULL),

  ('the_workhouse',
   'Define The Workhouse scope, systems and primary metric',
   'Fendi', 'OPEN', 'FENDI_DECISION', 'OPERATIONAL', 'P3',
   'A decision from Fendi',
   'muse_v1_build', 'muse_domains.the_workhouse',
   now(), 'Define what this domain covers and which single metric matters first',
   now() + interval '30 days', 'CLAIMED', NULL, NULL),

  ('community_nonprofit',
   'Define nonprofit/community scope and primary metric',
   'Fendi', 'OPEN', 'FENDI_DECISION', 'OPERATIONAL', 'P3',
   'A decision from Fendi',
   'muse_v1_build', 'muse_domains.community_nonprofit',
   now(), 'Define what this domain covers and which single metric matters first',
   now() + interval '30 days', 'CLAIMED', NULL, NULL)
) AS v(domain_key, title, owner, state, classification, category, priority, dependency,
       source, source_ref, last_evidence_at, next_action, review_at, verification_state,
       derive_resolution_from, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.muse_open_loops l WHERE l.title = v.title
);

-- ===========================================================================
-- 28. SEED — decision register
-- ===========================================================================
INSERT INTO public.muse_decisions
  (domain_key, question, context, evidence, options, owner, classification, status,
   decision_required_by, source, source_ref)
SELECT v.* FROM (VALUES
  ('ai_technical_systems',
   'Which credential model should Muse use to read other Supabase projects?',
   'Boltz and AVT are separate Supabase projects, so Control Hub cannot build views over them. Muse needs a read path that does not hand out a service-role key.',
   '["Boltz project smrbsnnisvmubbwfhafy is separate from Control Hub wkzwcfmvnwolgrdpnygc","Control Hub already has a connected_projects table used by telegram-webhook","This migration creates a muse_reader role as the least-privilege pattern"]'::jsonb,
   '[{"option":"Per-project muse_reader role + scoped JWT","pro":"Least privilege; read-only enforced by the database; revocable per project","con":"One migration per project"},{"option":"Control Hub edge function proxy holding each project key","pro":"Single place to audit and rate limit","con":"Control Hub then holds broader credentials"},{"option":"Service-role key per project in Control Hub secrets","pro":"Fastest","con":"Rejected by the security rules for this build — unrestricted write access behind a read feature"}]'::jsonb,
   'Fendi', 'FENDI_DECISION', 'PENDING', now() + interval '7 days',
   'muse_v1_build', 'docs/MUSE_EXECUTIVE_LAYER.md'),

  ('boltz_automotive',
   'Which system is authoritative for Boltz revenue?',
   'Muse can register lead and conversation authority for Boltz, but no revenue system was found in any repository or database reachable from Control Hub.',
   '["Boltz Insight Engine holds leads, messages and escalations but no revenue tables","No accounting or invoicing system is referenced in Control Hub"]'::jsonb,
   '[{"option":"Boltz Insight Engine (add revenue tracking)","con":"Requires build work in that project"},{"option":"An external accounting system","con":"Needs an access path for Muse"},{"option":"Not measured for now","con":"Portfolio stays blind to the money question"}]'::jsonb,
   'Fendi', 'FENDI_DECISION', 'PENDING', now() + interval '14 days',
   'muse_v1_build', 'muse_kpi_registry.boltz.revenue_30d'),

  ('tax_credit_services',
   'Is Tax & Credit Services its own portfolio domain, or part of The Workhouse?',
   'The portfolio list named seven domains, none of which covers the tax and credit operations that hold the largest live dataset in Control Hub.',
   '["public.clients, public.tax_returns, public.documents, public.dispute_letters are all live in Control Hub","The named portfolio list does not include a tax or credit domain"]'::jsonb,
   '[{"option":"Its own domain","pro":"Matches where the data and systems actually live"},{"option":"Part of The Workhouse","pro":"Fewer domains to review"},{"option":"Rename to match how Fendi thinks about it"}]'::jsonb,
   'Fendi', 'FENDI_DECISION', 'PENDING', now() + interval '7 days',
   'muse_v1_build', 'muse_domains.tax_credit_services'),

  ('fendi_frost_music',
   'Should Control Hub pitch and playlist tables remain a second copy of music truth?',
   'AGH is named as the music source of truth, but Control Hub writes and stores pitch_drafts and playlist_research locally.',
   '["public.pitch_drafts and public.playlist_research are live in Control Hub","generate-pitch-email and playlist-research edge functions write to them"]'::jsonb,
   '[{"option":"Control Hub is authoritative for pitching; AGH for audience"},{"option":"AGH is authoritative; Control Hub rows become a working cache"},{"option":"Keep both and record a permanent conflict"}]'::jsonb,
   'Fendi', 'FENDI_DECISION', 'PENDING', now() + interval '21 days',
   'muse_v1_build', 'muse_source_authority')
) AS v(domain_key, question, context, evidence, options, owner, classification, status,
       decision_required_by, source, source_ref)
WHERE NOT EXISTS (
  SELECT 1 FROM public.muse_decisions dc WHERE dc.question = v.question
);

-- ===========================================================================
-- 29. SEED — 1% improvement ledger
-- ===========================================================================
INSERT INTO public.muse_improvements
  (domain_key, baseline, problem, intervention, metric, expected_result, owner,
   started_at, review_at, verdict, status, verification_state, source_ref, notes)
SELECT v.* FROM (VALUES
  ('ai_technical_systems',
   'Zero domains had a single place showing status, owner, source of truth and system health',
   'Executive visibility required Fendi to restate information that already existed in operational systems',
   'Muse executive layer embedded in Control Hub: portfolio map, open loops, source authority, agent health, 1% ledger',
   'Domains mapped with a declared source of truth, and systems with derived health visible in one view',
   '8 domains mapped; 21 systems registered; 12 with live derived telemetry',
   'Fendi', now(), now() + interval '30 days', 'PENDING', 'RUNNING', 'CLAIMED',
   'supabase/migrations/20260925120000_muse_executive_layer.sql',
   'Verdict stays PENDING until the layer is live-verified and used for one monthly review.'),

  ('ai_technical_systems',
   'Most background workers have no declared cadence, so silence cannot be told from success',
   'A worker that stops running looks identical to a worker with nothing to do',
   'Record each worker cadence in muse_systems.cadence_minutes so the health view can report STALE',
   'Registered systems with a non-null cadence_minutes',
   'All queue and cron workers carry a real cadence',
   'Fendi', NULL, now() + interval '14 days', 'PENDING', 'PROPOSED', 'CLAIMED',
   'public.muse_systems',
   'Blocked on the cadence open loop; measurement is honest only after cadences are confirmed.')
) AS v(domain_key, baseline, problem, intervention, metric, expected_result, owner,
       started_at, review_at, verdict, status, verification_state, source_ref, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.muse_improvements i WHERE i.problem = v.problem
);

-- ===========================================================================
-- 30. SEED — verification ledger
-- ===========================================================================
-- Recorded as CLAIMED on purpose. This build writing a row does not make it true.
INSERT INTO public.muse_verifications
  (subject_type, subject_ref, claim, verification_state, claimed_by, repo, branch, notes)
SELECT v.* FROM (VALUES
  ('migration', '20260925120000_muse_executive_layer.sql',
   'Muse v1 schema, views, privileges and seeds authored',
   'ARTIFACT_VERIFIED', 'claude-code',
   'fendifrost-dot/fendi-control-center', 'claude/fervent-heisenberg-ip9fqw',
   'Artifact exists in GitHub and was validated against a local PostgreSQL 16 harness. Not applied to the live database by this claim.'),
  ('edge_function', 'muse-executive',
   'Read-only executive API implemented (GET only, token auth, audited, rate limited)',
   'CLAIMED', 'claude-code',
   'fendifrost-dot/fendi-control-center', 'claude/fervent-heisenberg-ip9fqw',
   'Requires a Lovable edge redeploy before it is live. Promote to LIVE_VERIFIED only from scripts/muse/verify-muse-live.mjs output.'),
  ('ui_module', '/muse',
   'Muse module added to Control Hub UI (brief, portfolio, loops, ledger, sources, systems)',
   'CLAIMED', 'claude-code',
   'fendifrost-dot/fendi-control-center', 'claude/fervent-heisenberg-ip9fqw',
   'Requires a Lovable publish before it is live.')
) AS v(subject_type, subject_ref, claim, verification_state, claimed_by, repo, branch, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.muse_verifications mv
  WHERE mv.subject_type = v.subject_type AND mv.subject_ref = v.subject_ref
);
