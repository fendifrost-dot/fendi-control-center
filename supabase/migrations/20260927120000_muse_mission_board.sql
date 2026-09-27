-- ============================================================================
-- MUSE MISSION BOARD + DAILY IMPROVEMENT ENGINE (v2)
-- ============================================================================
-- Extends the Muse v1 executive layer (20260925120000_muse_executive_layer.sql)
-- into a structured cross-agent operating board:
--
--   Fendi -> Muse (executive) -> Grok Bot (chief of staff) -> Claude / specialists
--
-- Agents coordinate through STATE, not prose. The state machine is enforced by
-- the database, so it holds whichever writer touches a row (Hub UI, an edge
-- function, a future agent tool, or the SQL editor).
--
-- Additive and idempotent:
--   * v1 tables are extended with new columns, never dropped or renamed.
--   * muse_improvements.status / verdict CHECKs are widened; the two legacy
--     statuses (RUNNING, MEASURED) are mapped onto the new lifecycle.
--   * v1 views keep every column in order; new columns are appended.
--   * New objects: 4 tables, 4 views, 8 functions. All prefixed muse_.
--
-- IMPORTANT: once this file is applied, do NOT re-run the v1 migration on its
-- own. Its CREATE OR REPLACE VIEW statements carry fewer columns than the views
-- below and will fail ("cannot drop columns from view"). Re-run THIS file
-- instead — it is safe to re-run.
--
-- The muse-executive read API stays GET-only. Writes go through the
-- muse_transition_* / muse_verify functions below, which are callable by the
-- signed-in operator and the service role (i.e. Control Hub execution paths),
-- never by anon or muse_reader.
-- ============================================================================

-- ===========================================================================
-- 0. AGENT HIERARCHY on the existing system registry
-- ===========================================================================
-- agent_tier makes the operating hierarchy machine-checkable:
--   EXECUTIVE       Muse — proposes, selects, decides verdicts
--   CHIEF_OF_STAFF  Grok Bot — assigns, coordinates, cancels, closes
--   SPECIALIST      Claude / Cursor / domain agents — execute assigned work
-- 'Fendi' is the owner and is recognised by name (see muse_actor_tier).
ALTER TABLE public.muse_systems ADD COLUMN IF NOT EXISTS agent_tier text;
ALTER TABLE public.muse_systems DROP CONSTRAINT IF EXISTS muse_systems_agent_tier_check;
ALTER TABLE public.muse_systems ADD CONSTRAINT muse_systems_agent_tier_check
  CHECK (agent_tier IS NULL OR agent_tier IN ('EXECUTIVE','CHIEF_OF_STAFF','SPECIALIST'));

INSERT INTO public.muse_systems
  (key, name, role, domain_key, expected_cadence, cadence_minutes, probe_key, owner_type,
   waits_on_human, downstream_impact, data_status, sort_order, blocker, agent_tier, notes)
VALUES
  ('muse', 'Muse', 'Executive intelligence: proposes and selects improvements, judges results',
   'ai_technical_systems', 'daily review', NULL, NULL, 'MUSE_ANALYSIS', false,
   'Nothing is prioritised, measured or judged; the board goes quiet',
   'NEEDS_VERIFICATION', 5, 'Muse reads via muse-executive; it has no write path of its own yet', 'EXECUTIVE',
   'Selects work and decides KEEP/REVISE/REVERSE/INCONCLUSIVE. Never modifies production directly.'),
  ('grok-bot', 'Grok Bot', 'Chief of Staff over AI agents: assigns, coordinates, chases verification',
   'ai_technical_systems', 'on selection', NULL, NULL, 'DELEGATE_TO_AGENT', false,
   'Selected improvements are never assigned; tasks stall without an owner',
   'NEEDS_VERIFICATION', 6, 'Which runtime hosts the Chief of Staff role is not wired to the board yet', 'CHIEF_OF_STAFF',
   'Distinct registry entry from boltz-grok-agent (Boltz lead replies). Whether both are the same runtime is an open question, recorded rather than assumed.')
ON CONFLICT (key) DO NOTHING;

UPDATE public.muse_systems SET agent_tier = 'SPECIALIST'
 WHERE key IN ('claude-code','cursor-workflows','boltz-grok-agent') AND agent_tier IS NULL;

-- ===========================================================================
-- 1. SHARED HELPERS
-- ===========================================================================
-- Verification states are ordered; comparisons go through this rank.
CREATE OR REPLACE FUNCTION public.muse_verification_rank(p_state text)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE p_state
    WHEN 'CLAIMED' THEN 0
    WHEN 'ARTIFACT_VERIFIED' THEN 1
    WHEN 'SYSTEM_VERIFIED' THEN 2
    WHEN 'LIVE_VERIFIED' THEN 3
    ELSE -1 END
$$;

-- One normalised metric identity, used by collision protection.
CREATE OR REPLACE FUNCTION public.muse_metric_norm(p_metric_key text, p_metric text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT lower(coalesce(nullif(btrim(p_metric_key), ''), btrim(p_metric)))
$$;

-- The acting agent for the current transaction, set only by the transition
-- functions. NULL means "not called through a transition function".
CREATE OR REPLACE FUNCTION public.muse_current_actor()
RETURNS text LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT nullif(current_setting('muse.actor', true), '')
$$;

-- OWNER (Fendi) | EXECUTIVE | CHIEF_OF_STAFF | SPECIALIST | SYSTEM (internal) | NULL (unknown)
CREATE OR REPLACE FUNCTION public.muse_actor_tier(p_actor text)
RETURNS text LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_actor IS NULL THEN NULL
    WHEN lower(p_actor) = 'fendi' THEN 'OWNER'
    WHEN p_actor = 'system:auto' THEN 'SYSTEM'
    ELSE (SELECT s.agent_tier FROM public.muse_systems s WHERE s.key = p_actor AND s.is_active)
  END
$$;

-- ===========================================================================
-- 2. MISSION BOARD
-- ===========================================================================
-- Portfolio objectives. A mission is an outcome, not an implementation task.
CREATE TABLE IF NOT EXISTS public.muse_missions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_key         text NOT NULL REFERENCES public.muse_domains(key) ON UPDATE CASCADE,
  title              text NOT NULL,
  objective          text NOT NULL,
  business_outcome   text,
  owner              text NOT NULL DEFAULT 'Fendi',
  executive_sponsor  text NOT NULL DEFAULT 'Fendi',
  priority           text NOT NULL DEFAULT 'P2'
    CONSTRAINT muse_missions_priority_check CHECK (priority IN ('P0','P1','P2','P3')),
  status             text NOT NULL DEFAULT 'PROPOSED'
    CONSTRAINT muse_missions_status_check CHECK (status IN (
      'PROPOSED','ACTIVE','PAUSED','ACHIEVED','ABANDONED')),
  metric             text NOT NULL,
  -- Matches muse_kpi_registry.metric_key when the metric is registered.
  metric_key         text,
  baseline           text,
  target             text,
  start_date         date,
  review_date        date,
  dependencies       jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_ref         text,
  evidence           jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_attention    text NOT NULL DEFAULT 'NONE'
    CONSTRAINT muse_missions_owner_attention_check CHECK (owner_attention IN (
      'NONE','INFORM','APPROVAL','DECISION','DIRECT_INVOLVEMENT')),
  created_by         text NOT NULL,
  updated_by         text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.muse_missions IS
  'Portfolio-level objectives (outcome + metric + baseline + target). Implementation work hangs off improvements, never off a mission directly.';

-- ===========================================================================
-- 3. DAILY IMPROVEMENT = the existing 1% ledger, extended
-- ===========================================================================
-- muse_improvements already carries baseline, problem, intervention (proposed
-- improvement), metric, expected_result (expected impact), actual_result,
-- owner, review_at, verdict and verification_state. It is extended rather than
-- duplicated: a daily improvement is a row with improvement_date set.
ALTER TABLE public.muse_improvements
  ADD COLUMN IF NOT EXISTS kind                     text NOT NULL DEFAULT 'INTERVENTION',
  ADD COLUMN IF NOT EXISTS improvement_date         date,
  ADD COLUMN IF NOT EXISTS is_primary               boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS function_area            text,
  ADD COLUMN IF NOT EXISTS observation              text,
  ADD COLUMN IF NOT EXISTS hypothesis               text,
  ADD COLUMN IF NOT EXISTS metric_key               text,
  ADD COLUMN IF NOT EXISTS confidence               text,
  ADD COLUMN IF NOT EXISTS risk                     text,
  ADD COLUMN IF NOT EXISTS reversibility            text,
  ADD COLUMN IF NOT EXISTS priority                 text NOT NULL DEFAULT 'P2',
  ADD COLUMN IF NOT EXISTS recommended_executor     text REFERENCES public.muse_systems(key) ON UPDATE CASCADE,
  ADD COLUMN IF NOT EXISTS selected_by              text,
  ADD COLUMN IF NOT EXISTS selected_at              timestamptz,
  ADD COLUMN IF NOT EXISTS linked_mission_id        uuid REFERENCES public.muse_missions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS linked_experiment_id     uuid REFERENCES public.muse_improvements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS definition_of_done       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS verification_requirement text NOT NULL DEFAULT 'LIVE_VERIFIED',
  ADD COLUMN IF NOT EXISTS owner_attention          text NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS approved_by              text,
  ADD COLUMN IF NOT EXISTS approved_at              timestamptz,
  ADD COLUMN IF NOT EXISTS implemented_at           timestamptz,
  ADD COLUMN IF NOT EXISTS measurement_window_days  integer,
  ADD COLUMN IF NOT EXISTS next_iteration           text,
  ADD COLUMN IF NOT EXISTS collision_override       text,
  ADD COLUMN IF NOT EXISTS created_by               text,
  ADD COLUMN IF NOT EXISTS updated_by               text;

-- Widen the v1 vocabularies. Old constraints are dropped BEFORE legacy rows are
-- mapped, and the new ones are added after.
ALTER TABLE public.muse_improvements DROP CONSTRAINT IF EXISTS muse_improvements_status_check;
ALTER TABLE public.muse_improvements DROP CONSTRAINT IF EXISTS muse_improvements_verdict_check;
ALTER TABLE public.muse_improvements DROP CONSTRAINT IF EXISTS muse_improvements_verdict_stage_check;

-- Legacy mapping (v1 -> v2). RUNNING/MEASURED meant "live, being measured";
-- a row that already carries a verdict has been decided. No-op on re-run.
UPDATE public.muse_improvements
   SET status = 'DECIDED'
 WHERE verdict <> 'PENDING' AND status NOT IN ('DECIDED','CLOSED');
UPDATE public.muse_improvements
   SET status = 'MEASURING',
       implemented_at = coalesce(implemented_at, started_at)
 WHERE status IN ('RUNNING','MEASURED');

ALTER TABLE public.muse_improvements ADD CONSTRAINT muse_improvements_status_check
  CHECK (status IN ('PROPOSED','SELECTED','IN_EXECUTION','VERIFICATION','MEASURING',
                    'DECIDED','CLOSED','REJECTED'));
ALTER TABLE public.muse_improvements ADD CONSTRAINT muse_improvements_verdict_check
  CHECK (verdict IN ('PENDING','KEEP','REVISE','REVERSE','INCONCLUSIVE'));
-- A verdict exists only once a decision has been taken.
ALTER TABLE public.muse_improvements ADD CONSTRAINT muse_improvements_verdict_stage_check
  CHECK (verdict = 'PENDING' OR status IN ('DECIDED','CLOSED'));

DO $$
BEGIN
  ALTER TABLE public.muse_improvements DROP CONSTRAINT IF EXISTS muse_improvements_kind_check;
  ALTER TABLE public.muse_improvements ADD CONSTRAINT muse_improvements_kind_check
    CHECK (kind IN ('INTERVENTION','OBSERVE'));
  ALTER TABLE public.muse_improvements DROP CONSTRAINT IF EXISTS muse_improvements_confidence_check;
  ALTER TABLE public.muse_improvements ADD CONSTRAINT muse_improvements_confidence_check
    CHECK (confidence IS NULL OR confidence IN ('HIGH','MEDIUM','LOW'));
  ALTER TABLE public.muse_improvements DROP CONSTRAINT IF EXISTS muse_improvements_risk_check;
  ALTER TABLE public.muse_improvements ADD CONSTRAINT muse_improvements_risk_check
    CHECK (risk IS NULL OR risk IN ('LOW','MEDIUM','HIGH'));
  ALTER TABLE public.muse_improvements DROP CONSTRAINT IF EXISTS muse_improvements_reversibility_check;
  ALTER TABLE public.muse_improvements ADD CONSTRAINT muse_improvements_reversibility_check
    CHECK (reversibility IS NULL OR reversibility IN ('REVERSIBLE','PARTIALLY_REVERSIBLE','IRREVERSIBLE'));
  ALTER TABLE public.muse_improvements DROP CONSTRAINT IF EXISTS muse_improvements_priority_check;
  ALTER TABLE public.muse_improvements ADD CONSTRAINT muse_improvements_priority_check
    CHECK (priority IN ('P0','P1','P2','P3'));
  ALTER TABLE public.muse_improvements DROP CONSTRAINT IF EXISTS muse_improvements_verification_requirement_check;
  ALTER TABLE public.muse_improvements ADD CONSTRAINT muse_improvements_verification_requirement_check
    CHECK (verification_requirement IN ('CLAIMED','ARTIFACT_VERIFIED','SYSTEM_VERIFIED','LIVE_VERIFIED'));
  ALTER TABLE public.muse_improvements DROP CONSTRAINT IF EXISTS muse_improvements_owner_attention_check;
  ALTER TABLE public.muse_improvements ADD CONSTRAINT muse_improvements_owner_attention_check
    CHECK (owner_attention IN ('NONE','INFORM','APPROVAL','DECISION','DIRECT_INVOLVEMENT'));
  -- Owner attention budget: high-risk or irreversible work cannot be filed as
  -- something Fendi merely hears about.
  ALTER TABLE public.muse_improvements DROP CONSTRAINT IF EXISTS muse_improvements_escalation_check;
  ALTER TABLE public.muse_improvements ADD CONSTRAINT muse_improvements_escalation_check
    CHECK (NOT (coalesce(risk,'') = 'HIGH' OR coalesce(reversibility,'') = 'IRREVERSIBLE')
           OR owner_attention IN ('APPROVAL','DECISION','DIRECT_INVOLVEMENT'));
  ALTER TABLE public.muse_improvements DROP CONSTRAINT IF EXISTS muse_improvements_window_check;
  ALTER TABLE public.muse_improvements ADD CONSTRAINT muse_improvements_window_check
    CHECK (measurement_window_days IS NULL OR measurement_window_days BETWEEN 0 AND 365);
  ALTER TABLE public.muse_improvements DROP CONSTRAINT IF EXISTS muse_improvements_dod_check;
  ALTER TABLE public.muse_improvements ADD CONSTRAINT muse_improvements_dod_check
    CHECK (jsonb_typeof(definition_of_done) = 'array');
END $$;

-- One primary outcome per day (an intervention OR an explicit OBSERVE).
CREATE UNIQUE INDEX IF NOT EXISTS muse_improvements_one_primary_per_day
  ON public.muse_improvements (improvement_date)
  WHERE is_primary AND improvement_date IS NOT NULL AND status <> 'REJECTED';
CREATE INDEX IF NOT EXISTS muse_improvements_active_metric_idx
  ON public.muse_improvements (domain_key, public.muse_metric_norm(metric_key, metric))
  WHERE status IN ('SELECTED','IN_EXECUTION','VERIFICATION','MEASURING');

COMMENT ON COLUMN public.muse_improvements.kind IS
  'INTERVENTION changes something. OBSERVE records a deliberate "no change yet" while an existing experiment measures.';
COMMENT ON COLUMN public.muse_improvements.owner_attention IS
  'Owner attention budget: NONE (default) | INFORM | APPROVAL | DECISION | DIRECT_INVOLVEMENT.';

-- ===========================================================================
-- 4. AGENT QUEUE — execution tasks
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.muse_improvement_tasks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  improvement_id           uuid NOT NULL REFERENCES public.muse_improvements(id) ON DELETE RESTRICT,
  title                    text NOT NULL,
  executor                 text NOT NULL REFERENCES public.muse_systems(key) ON UPDATE CASCADE,
  assigned_by              text NOT NULL,
  objective                text,
  instructions             text,
  expected_artifact        text,
  definition_of_done       jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT muse_improvement_tasks_dod_check CHECK (jsonb_typeof(definition_of_done) = 'array'),
  priority                 text
    CONSTRAINT muse_improvement_tasks_priority_check CHECK (priority IS NULL OR priority IN ('P0','P1','P2','P3')),
  due_at                   timestamptz,
  state                    text NOT NULL DEFAULT 'ASSIGNED'
    CONSTRAINT muse_improvement_tasks_state_check CHECK (state IN (
      'ASSIGNED','IN_PROGRESS','WAITING','BLOCKED','IMPLEMENTED','VERIFICATION','COMPLETE','CANCELLED')),
  -- Required while BLOCKED or WAITING: what it is waiting on.
  blocker                  text,
  evidence                 jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT muse_improvement_tasks_evidence_check CHECK (jsonb_typeof(evidence) = 'array'),
  claimed_completion       text,
  claimed_at               timestamptz,
  verification_requirement text
    CONSTRAINT muse_improvement_tasks_verification_requirement_check CHECK (verification_requirement IS NULL
      OR verification_requirement IN ('CLAIMED','ARTIFACT_VERIFIED','SYSTEM_VERIFIED','LIVE_VERIFIED')),
  verification_id          uuid REFERENCES public.muse_verifications(id) ON DELETE SET NULL,
  completed_at             timestamptz,
  cancelled_reason         text,
  updated_by               text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT muse_improvement_tasks_blocker_check
    CHECK (state NOT IN ('BLOCKED','WAITING') OR blocker IS NOT NULL),
  CONSTRAINT muse_improvement_tasks_claim_check
    CHECK (state NOT IN ('IMPLEMENTED','VERIFICATION','COMPLETE') OR claimed_completion IS NOT NULL),
  CONSTRAINT muse_improvement_tasks_cancel_check
    CHECK (state <> 'CANCELLED' OR cancelled_reason IS NOT NULL)
);

-- "MY ASSIGNED TASKS" without scanning unrelated work.
CREATE INDEX IF NOT EXISTS muse_improvement_tasks_executor_open_idx
  ON public.muse_improvement_tasks (executor, state)
  WHERE state NOT IN ('COMPLETE','CANCELLED');
-- Duplicate-work guard: the same open task cannot be assigned twice.
CREATE UNIQUE INDEX IF NOT EXISTS muse_improvement_tasks_no_duplicate_open
  ON public.muse_improvement_tasks (improvement_id, lower(btrim(title)))
  WHERE state NOT IN ('COMPLETE','CANCELLED');

COMMENT ON TABLE public.muse_improvement_tasks IS
  'Execution tasks for a selected improvement. An executor claiming completion opens a verification; only a different verifier can complete the task.';

-- ===========================================================================
-- 5. IMPACT LEDGER — measurements
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.muse_improvement_measurements (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  improvement_id           uuid NOT NULL REFERENCES public.muse_improvements(id) ON DELETE RESTRICT,
  checkpoint               text NOT NULL
    CONSTRAINT muse_improvement_measurements_checkpoint_check CHECK (checkpoint IN (
      'BASELINE','IMMEDIATE','D7','D30','OTHER')),
  measured_at              timestamptz NOT NULL DEFAULT now(),
  window_start             timestamptz,
  window_end               timestamptz,
  metric_value             numeric,
  value_text               text,
  financial_impact_usd     numeric,
  time_saved_minutes       numeric,
  unintended_consequences  text,
  evidence                 jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT muse_improvement_measurements_evidence_check CHECK (jsonb_typeof(evidence) = 'array'),
  source_ref               text,
  data_status              text NOT NULL DEFAULT 'NEEDS_VERIFICATION'
    CONSTRAINT muse_improvement_measurements_data_status_check CHECK (data_status IN (
      'KNOWN','AVAILABLE_NOT_CONNECTED','SOURCE_EXISTS_ACCESS_NEEDED',
      'NOT_MEASURED','UNKNOWN','NEEDS_VERIFICATION')),
  recorded_by              text NOT NULL,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT muse_improvement_measurements_value_check
    CHECK (metric_value IS NOT NULL OR value_text IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS muse_improvement_measurements_one_per_checkpoint
  ON public.muse_improvement_measurements (improvement_id, checkpoint)
  WHERE checkpoint <> 'OTHER';

COMMENT ON TABLE public.muse_improvement_measurements IS
  'Append-only measurements per improvement (baseline, immediate, 7-day, 30-day). D7/D30 cannot be recorded before the window has elapsed.';

-- ===========================================================================
-- 6. VERIFICATION QUEUE — extend the v1 ledger
-- ===========================================================================
ALTER TABLE public.muse_verifications
  ADD COLUMN IF NOT EXISTS required_state  text,
  ADD COLUMN IF NOT EXISTS artifact_ref    text,
  ADD COLUMN IF NOT EXISTS system_evidence text,
  ADD COLUMN IF NOT EXISTS live_evidence   text,
  ADD COLUMN IF NOT EXISTS failure_reason  text,
  ADD COLUMN IF NOT EXISTS failed_at       timestamptz;
ALTER TABLE public.muse_verifications DROP CONSTRAINT IF EXISTS muse_verifications_required_state_check;
ALTER TABLE public.muse_verifications ADD CONSTRAINT muse_verifications_required_state_check
  CHECK (required_state IS NULL OR required_state IN (
    'CLAIMED','ARTIFACT_VERIFIED','SYSTEM_VERIFIED','LIVE_VERIFIED'));

-- ===========================================================================
-- 7. STATE HISTORY (append-only)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.muse_state_events (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  subject_type text NOT NULL,
  subject_id   uuid NOT NULL,
  from_state   text,
  to_state     text NOT NULL,
  actor        text NOT NULL,
  note         text
);
CREATE INDEX IF NOT EXISTS muse_state_events_subject_idx
  ON public.muse_state_events (subject_type, subject_id, at);

COMMENT ON TABLE public.muse_state_events IS
  'Every state change on missions, improvements, tasks and verifications. Written only by triggers; nobody can edit or delete history.';

-- Runs as the table owner so history is writable by triggers but not by callers.
CREATE OR REPLACE FUNCTION public.muse_log_state_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n jsonb := to_jsonb(NEW);
  o jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
  subject text;
  col text;
  from_s text;
  to_s text;
  who text;
BEGIN
  subject := CASE TG_TABLE_NAME
    WHEN 'muse_missions' THEN 'mission'
    WHEN 'muse_improvements' THEN 'improvement'
    WHEN 'muse_improvement_tasks' THEN 'task'
    WHEN 'muse_verifications' THEN 'verification'
  END;
  col := CASE TG_TABLE_NAME
    WHEN 'muse_improvement_tasks' THEN 'state'
    WHEN 'muse_verifications' THEN 'verification_state'
    ELSE 'status'
  END;
  from_s := o ->> col;
  to_s := n ->> col;
  IF TG_TABLE_NAME = 'muse_verifications' AND (n ->> 'failed_at') IS NOT NULL
     AND (o IS NULL OR (o ->> 'failed_at') IS NULL) THEN
    to_s := 'FAILED';
  END IF;
  who := coalesce(public.muse_current_actor(),
                  n ->> 'updated_by', n ->> 'created_by', n ->> 'assigned_by',
                  n ->> 'verified_by', n ->> 'claimed_by', 'unrecorded');
  INSERT INTO public.muse_state_events (subject_type, subject_id, from_state, to_state, actor, note)
  VALUES (subject, (n ->> 'id')::uuid, from_s, to_s, who,
          nullif(current_setting('muse.note', true), ''));
  RETURN NULL;
END $$;

-- ===========================================================================
-- 8. STATE MACHINE — missions
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.muse_missions_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  actor text;
  tier text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('PROPOSED','ACTIVE') THEN
      RAISE EXCEPTION 'muse: a new mission starts PROPOSED or ACTIVE (got %)', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF coalesce(public.muse_actor_tier(NEW.created_by), '') NOT IN ('OWNER','EXECUTIVE') THEN
      RAISE EXCEPTION 'muse: missions are created by Fendi or Muse, not %', NEW.created_by
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.updated_by := coalesce(NEW.updated_by, NEW.created_by);
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  actor := public.muse_current_actor();
  IF actor IS NULL THEN
    RAISE EXCEPTION 'muse: mission status changes go through muse_transition_mission()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  tier := public.muse_actor_tier(actor);
  IF tier IS NULL OR tier NOT IN ('OWNER','EXECUTIVE') THEN
    RAISE EXCEPTION 'muse: % (%) cannot change a mission''s status', actor, coalesce(tier,'unknown actor')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (
       (OLD.status = 'PROPOSED' AND NEW.status IN ('ACTIVE','ABANDONED'))
    OR (OLD.status = 'ACTIVE'   AND NEW.status IN ('PAUSED','ACHIEVED','ABANDONED'))
    OR (OLD.status = 'PAUSED'   AND NEW.status IN ('ACTIVE','ABANDONED'))
  ) THEN
    RAISE EXCEPTION 'muse: mission transition % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_by := actor;
  RETURN NEW;
END $$;

-- ===========================================================================
-- 9. STATE MACHINE — improvements
-- ===========================================================================
--  INTERVENTION:
--    PROPOSED -> SELECTED -> IN_EXECUTION -> VERIFICATION -> MEASURING -> DECIDED -> CLOSED
--    PROPOSED|SELECTED|IN_EXECUTION -> REJECTED ; SELECTED -> PROPOSED ;
--    VERIFICATION -> IN_EXECUTION (rework)
--  OBSERVE:
--    PROPOSED -> SELECTED -> CLOSED ; PROPOSED|SELECTED -> REJECTED
CREATE OR REPLACE FUNCTION public.muse_improvements_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  actor text;
  tier text;
  n int;
  clash record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PROPOSED' THEN
      RAISE EXCEPTION 'muse: a new improvement starts PROPOSED (got %)', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_by := coalesce(NEW.created_by, public.muse_current_actor());
    tier := public.muse_actor_tier(NEW.created_by);
    -- Specialists execute; they do not set business priorities. They raise
    -- an open loop instead.
    IF tier IS NULL OR tier NOT IN ('OWNER','EXECUTIVE','CHIEF_OF_STAFF') THEN
      RAISE EXCEPTION 'muse: improvements are proposed by Fendi, Muse or Grok Bot, not % (%)',
        coalesce(NEW.created_by,'<no created_by>'), coalesce(tier,'unknown actor')
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.updated_by := coalesce(NEW.updated_by, NEW.created_by);
    NEW.selected_by := NULL;
    NEW.selected_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.kind IS DISTINCT FROM OLD.kind AND OLD.status <> 'PROPOSED' THEN
    RAISE EXCEPTION 'muse: kind is fixed once an improvement leaves PROPOSED'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  actor := public.muse_current_actor();
  IF actor IS NULL THEN
    RAISE EXCEPTION 'muse: improvement status changes go through muse_transition_improvement()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  tier := public.muse_actor_tier(actor);
  IF tier IS NULL THEN
    RAISE EXCEPTION 'muse: unknown actor %', actor USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Allowed edges.
  IF NOT (
       (OLD.status = 'PROPOSED'     AND NEW.status IN ('SELECTED','REJECTED'))
    OR (OLD.status = 'SELECTED'     AND NEW.status IN ('PROPOSED','REJECTED'))
    OR (OLD.status = 'SELECTED'     AND NEW.status = 'IN_EXECUTION' AND NEW.kind = 'INTERVENTION')
    OR (OLD.status = 'SELECTED'     AND NEW.status = 'CLOSED'       AND NEW.kind = 'OBSERVE')
    OR (OLD.status = 'IN_EXECUTION' AND NEW.status IN ('VERIFICATION','REJECTED'))
    OR (OLD.status = 'VERIFICATION' AND NEW.status IN ('MEASURING','IN_EXECUTION'))
    OR (OLD.status = 'MEASURING'    AND NEW.status = 'DECIDED')
    OR (OLD.status = 'DECIDED'      AND NEW.status = 'CLOSED')
  ) THEN
    RAISE EXCEPTION 'muse: improvement transition % -> % is not allowed (kind %)', OLD.status, NEW.status, NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;

  -- Who may take each edge.
  IF NEW.status IN ('SELECTED','PROPOSED','DECIDED')
     OR (NEW.status = 'REJECTED' AND OLD.status IN ('PROPOSED','SELECTED'))
     OR (NEW.status = 'CLOSED' AND NEW.kind = 'OBSERVE') THEN
    IF tier NOT IN ('OWNER','EXECUTIVE') THEN
      RAISE EXCEPTION 'muse: only Fendi or Muse may move an improvement to % (actor % is %)', NEW.status, actor, tier
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.status IN ('IN_EXECUTION','VERIFICATION') THEN
    IF tier NOT IN ('OWNER','EXECUTIVE','CHIEF_OF_STAFF','SYSTEM') THEN
      RAISE EXCEPTION 'muse: only Fendi, Muse or Grok Bot may move an improvement to % (actor % is %)', NEW.status, actor, tier
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF tier NOT IN ('OWNER','EXECUTIVE','CHIEF_OF_STAFF') THEN
    RAISE EXCEPTION 'muse: % (%) may not move an improvement to %', actor, tier, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Edge preconditions.
  IF NEW.status = 'SELECTED' THEN
    IF NEW.kind = 'INTERVENTION' THEN
      IF NEW.risk IS NULL OR NEW.reversibility IS NULL OR NEW.confidence IS NULL
         OR NEW.recommended_executor IS NULL
         OR jsonb_array_length(NEW.definition_of_done) = 0
         OR (NEW.measurement_window_days IS NULL AND NEW.review_at IS NULL) THEN
        RAISE EXCEPTION 'muse: an intervention needs risk, reversibility, confidence, recommended_executor, definition_of_done and a measurement window before it can be SELECTED'
          USING ERRCODE = 'check_violation';
      END IF;
      -- Experiment collision protection: one live experiment per metric per domain.
      SELECT o.id, o.intervention, o.status INTO clash
        FROM public.muse_improvements o
       WHERE o.id <> NEW.id
         AND o.kind = 'INTERVENTION'
         AND o.domain_key = NEW.domain_key
         AND o.status IN ('SELECTED','IN_EXECUTION','VERIFICATION','MEASURING')
         AND public.muse_metric_norm(o.metric_key, o.metric) = public.muse_metric_norm(NEW.metric_key, NEW.metric)
       LIMIT 1;
      IF FOUND AND NEW.collision_override IS NULL THEN
        RAISE EXCEPTION 'muse: metric "%" in % already has an active experiment (% "%", %). Prefer OBSERVE, or set collision_override with a reason.',
          NEW.metric, NEW.domain_key, clash.status, clash.intervention, clash.id
          USING ERRCODE = 'unique_violation';
      END IF;
    ELSIF NEW.observation IS NULL THEN
      RAISE EXCEPTION 'muse: an OBSERVE outcome must record what is being observed'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.selected_by := actor;
    NEW.selected_at := now();
  ELSIF NEW.status = 'PROPOSED' THEN
    NEW.selected_by := NULL;
    NEW.selected_at := NULL;
  ELSIF NEW.status = 'IN_EXECUTION' AND OLD.status = 'SELECTED' THEN
    IF NEW.owner_attention IN ('APPROVAL','DECISION','DIRECT_INVOLVEMENT')
       AND (NEW.approved_at IS NULL OR lower(coalesce(NEW.approved_by,'')) <> 'fendi') THEN
      RAISE EXCEPTION 'muse: owner_attention % requires Fendi''s approval (approved_by/approved_at) before execution', NEW.owner_attention
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT count(*) INTO n FROM public.muse_improvement_tasks t
     WHERE t.improvement_id = NEW.id AND t.state NOT IN ('COMPLETE','CANCELLED');
    IF n = 0 THEN
      RAISE EXCEPTION 'muse: IN_EXECUTION needs at least one assigned task'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'VERIFICATION' THEN
    SELECT count(*) INTO n FROM public.muse_improvement_tasks t
     WHERE t.improvement_id = NEW.id AND t.state NOT IN ('COMPLETE','CANCELLED');
    IF n > 0 THEN
      RAISE EXCEPTION 'muse: % task(s) still open; VERIFICATION needs every task complete or cancelled', n
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO n FROM public.muse_improvement_tasks t
     WHERE t.improvement_id = NEW.id AND t.state = 'COMPLETE';
    IF n = 0 THEN
      RAISE EXCEPTION 'muse: VERIFICATION needs at least one completed task'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'REJECTED' THEN
    SELECT count(*) INTO n FROM public.muse_improvement_tasks t
     WHERE t.improvement_id = NEW.id AND t.state NOT IN ('COMPLETE','CANCELLED');
    IF n > 0 THEN
      RAISE EXCEPTION 'muse: cancel the % open task(s) before rejecting', n
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'MEASURING' THEN
    IF public.muse_verification_rank(NEW.verification_state)
       < public.muse_verification_rank(NEW.verification_requirement) THEN
      RAISE EXCEPTION 'muse: verification is % but % is required before measuring starts',
        NEW.verification_state, NEW.verification_requirement
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.implemented_at := coalesce(NEW.implemented_at, now());
    NEW.started_at := coalesce(NEW.started_at, NEW.implemented_at);
    NEW.review_at := coalesce(NEW.review_at,
      NEW.implemented_at + make_interval(days => coalesce(NEW.measurement_window_days, 7)));
  ELSIF NEW.status = 'DECIDED' THEN
    IF NEW.verdict = 'PENDING' THEN
      RAISE EXCEPTION 'muse: DECIDED requires a verdict (KEEP, REVISE, REVERSE or INCONCLUSIVE)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.verdict = 'KEEP' THEN
      SELECT count(*) INTO n FROM public.muse_improvement_measurements m
       WHERE m.improvement_id = NEW.id AND m.checkpoint <> 'BASELINE' AND m.data_status = 'KNOWN';
      IF n = 0 THEN
        RAISE EXCEPTION 'muse: KEEP needs at least one post-baseline measurement with data_status KNOWN'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      SELECT count(*) INTO n FROM public.muse_improvement_measurements m
       WHERE m.improvement_id = NEW.id AND m.checkpoint <> 'BASELINE';
      IF n = 0 AND NEW.actual_result IS NULL THEN
        RAISE EXCEPTION 'muse: a % verdict needs a post-baseline measurement or an actual_result', NEW.verdict
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.verdict = 'REVISE' AND NEW.next_iteration IS NULL THEN
      RAISE EXCEPTION 'muse: REVISE must name the next iteration'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  NEW.updated_by := actor;
  RETURN NEW;
END $$;

-- ===========================================================================
-- 10. STATE MACHINE — tasks
-- ===========================================================================
--  ASSIGNED    -> IN_PROGRESS | WAITING | BLOCKED | CANCELLED
--  IN_PROGRESS -> WAITING | BLOCKED | IMPLEMENTED | CANCELLED
--  WAITING     -> IN_PROGRESS | BLOCKED | CANCELLED
--  BLOCKED     -> IN_PROGRESS | WAITING | CANCELLED
--  IMPLEMENTED -> VERIFICATION | IN_PROGRESS
--  VERIFICATION-> COMPLETE | IN_PROGRESS
CREATE OR REPLACE FUNCTION public.muse_tasks_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  actor text;
  tier text;
  parent public.muse_improvements%ROWTYPE;
  v public.muse_verifications%ROWTYPE;
  new_verification uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'ASSIGNED' THEN
      RAISE EXCEPTION 'muse: a new task starts ASSIGNED (got %)', NEW.state USING ERRCODE = 'check_violation';
    END IF;
    tier := public.muse_actor_tier(NEW.assigned_by);
    IF tier IS NULL OR tier NOT IN ('OWNER','EXECUTIVE','CHIEF_OF_STAFF') THEN
      RAISE EXCEPTION 'muse: tasks are assigned by Fendi, Muse or Grok Bot, not % (%)', NEW.assigned_by, coalesce(tier,'unknown actor')
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF public.muse_actor_tier(NEW.executor) IS NULL THEN
      RAISE EXCEPTION 'muse: executor % is not a registered agent (muse_systems.agent_tier is empty)', NEW.executor
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO parent FROM public.muse_improvements WHERE id = NEW.improvement_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'muse: no improvement %', NEW.improvement_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF parent.kind <> 'INTERVENTION' OR parent.status NOT IN ('SELECTED','IN_EXECUTION') THEN
      RAISE EXCEPTION 'muse: tasks attach to a SELECTED or IN_EXECUTION intervention (parent is % %)', parent.kind, parent.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF parent.owner_attention IN ('APPROVAL','DECISION','DIRECT_INVOLVEMENT')
       AND (parent.approved_at IS NULL OR lower(coalesce(parent.approved_by,'')) <> 'fendi') THEN
      RAISE EXCEPTION 'muse: improvement needs Fendi''s approval (%) before work is assigned', parent.owner_attention
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.verification_requirement := coalesce(NEW.verification_requirement, parent.verification_requirement);
    NEW.priority := coalesce(NEW.priority, parent.priority);
    NEW.updated_by := coalesce(NEW.updated_by, NEW.assigned_by);
    NEW.claimed_completion := NULL;
    NEW.claimed_at := NULL;
    NEW.verification_id := NULL;
    NEW.completed_at := NULL;
    RETURN NEW;
  END IF;

  IF OLD.state IN ('COMPLETE','CANCELLED') THEN
    RAISE EXCEPTION 'muse: task % is % and cannot change', OLD.id, OLD.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.improvement_id IS DISTINCT FROM OLD.improvement_id OR NEW.executor IS DISTINCT FROM OLD.executor
     OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by THEN
    RAISE EXCEPTION 'muse: improvement, executor and assigner are fixed; cancel and reassign instead'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.verification_id IS DISTINCT FROM OLD.verification_id AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'muse: verification_id is set by the state machine only' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  actor := public.muse_current_actor();
  IF actor IS NULL THEN
    RAISE EXCEPTION 'muse: task state changes go through muse_transition_task() or muse_verify()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  tier := public.muse_actor_tier(actor);
  IF tier IS NULL THEN
    RAISE EXCEPTION 'muse: unknown actor %', actor USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT (
       (OLD.state = 'ASSIGNED'     AND NEW.state IN ('IN_PROGRESS','WAITING','BLOCKED','CANCELLED'))
    OR (OLD.state = 'IN_PROGRESS'  AND NEW.state IN ('WAITING','BLOCKED','IMPLEMENTED','CANCELLED'))
    OR (OLD.state = 'WAITING'      AND NEW.state IN ('IN_PROGRESS','BLOCKED','CANCELLED'))
    OR (OLD.state = 'BLOCKED'      AND NEW.state IN ('IN_PROGRESS','WAITING','CANCELLED'))
    OR (OLD.state = 'IMPLEMENTED'  AND NEW.state IN ('VERIFICATION','IN_PROGRESS'))
    OR (OLD.state = 'VERIFICATION' AND NEW.state IN ('COMPLETE','IN_PROGRESS'))
  ) THEN
    RAISE EXCEPTION 'muse: task transition % -> % is not allowed', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state IN ('IN_PROGRESS','WAITING','BLOCKED','IMPLEMENTED')
     AND OLD.state NOT IN ('IMPLEMENTED','VERIFICATION')
     AND actor <> NEW.executor AND tier NOT IN ('OWNER','EXECUTIVE','CHIEF_OF_STAFF') THEN
    RAISE EXCEPTION 'muse: only the executor (%) or a coordinator may move this task to %', NEW.executor, NEW.state
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.state = 'CANCELLED' AND tier NOT IN ('OWNER','EXECUTIVE','CHIEF_OF_STAFF') THEN
    RAISE EXCEPTION 'muse: only Fendi, Muse or Grok Bot may cancel a task' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- An agent saying "done" is not completion: the executor cannot verify or
  -- complete its own work.
  IF NEW.state IN ('VERIFICATION','COMPLETE') AND actor = NEW.executor THEN
    RAISE EXCEPTION 'muse: % cannot verify or complete its own task', actor USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.state = 'IN_PROGRESS' THEN
    NEW.blocker := NULL;
  ELSIF NEW.state = 'IMPLEMENTED' THEN
    IF NEW.claimed_completion IS NULL THEN
      RAISE EXCEPTION 'muse: IMPLEMENTED requires claimed_completion (what the executor says is done)'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.claimed_at := now();
    INSERT INTO public.muse_verifications
      (subject_type, subject_ref, claim, verification_state, claimed_by, required_state, artifact_ref, notes)
    VALUES
      ('improvement_task', NEW.id::text, NEW.claimed_completion, 'CLAIMED', NEW.executor,
       coalesce(NEW.verification_requirement, 'LIVE_VERIFIED'), NEW.expected_artifact,
       'Opened automatically when ' || NEW.executor || ' marked the task IMPLEMENTED.')
    RETURNING id INTO new_verification;
    NEW.verification_id := new_verification;
  ELSIF NEW.state = 'COMPLETE' THEN
    SELECT * INTO v FROM public.muse_verifications WHERE id = NEW.verification_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'muse: task has no verification record' USING ERRCODE = 'check_violation';
    END IF;
    IF v.failed_at IS NOT NULL THEN
      RAISE EXCEPTION 'muse: verification failed (%); send the task back to IN_PROGRESS', v.failure_reason
        USING ERRCODE = 'check_violation';
    END IF;
    IF v.verified_by IS NULL OR v.verified_by = NEW.executor OR v.verified_by = v.claimed_by THEN
      RAISE EXCEPTION 'muse: completion needs a verifier other than the executor' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF public.muse_verification_rank(v.verification_state)
       < public.muse_verification_rank(coalesce(v.required_state, NEW.verification_requirement, 'LIVE_VERIFIED')) THEN
      RAISE EXCEPTION 'muse: verification is % but % is required', v.verification_state,
        coalesce(v.required_state, NEW.verification_requirement, 'LIVE_VERIFIED')
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.completed_at := now();
  END IF;

  NEW.updated_by := actor;
  RETURN NEW;
END $$;

-- After a task changes: move the parent improvement along when the state of its
-- tasks makes the next step unambiguous. Runs as 'system:auto' so the history
-- shows the board, not an agent, took the step.
CREATE OR REPLACE FUNCTION public.muse_tasks_advance_parent()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  parent public.muse_improvements%ROWTYPE;
  prev_actor text := coalesce(current_setting('muse.actor', true), '');
  prev_note text := coalesce(current_setting('muse.note', true), '');
  open_n int;
  done_n int;
  weakest int;
BEGIN
  SELECT * INTO parent FROM public.muse_improvements WHERE id = NEW.improvement_id;

  IF TG_OP = 'INSERT' AND parent.status = 'SELECTED' THEN
    PERFORM set_config('muse.actor', 'system:auto', true);
    PERFORM set_config('muse.note', 'first task assigned by ' || NEW.assigned_by || ' to ' || NEW.executor, true);
    UPDATE public.muse_improvements SET status = 'IN_EXECUTION' WHERE id = parent.id;
  ELSIF TG_OP = 'UPDATE' AND NEW.state IN ('COMPLETE','CANCELLED') AND parent.status = 'IN_EXECUTION' THEN
    SELECT count(*) FILTER (WHERE t.state NOT IN ('COMPLETE','CANCELLED')),
           count(*) FILTER (WHERE t.state = 'COMPLETE'),
           min(public.muse_verification_rank(v.verification_state)) FILTER (WHERE t.state = 'COMPLETE')
      INTO open_n, done_n, weakest
      FROM public.muse_improvement_tasks t
      LEFT JOIN public.muse_verifications v ON v.id = t.verification_id
     WHERE t.improvement_id = parent.id;
    IF open_n = 0 AND done_n > 0 THEN
      PERFORM set_config('muse.actor', 'system:auto', true);
      PERFORM set_config('muse.note', 'all tasks closed; improvement carries its weakest task verification', true);
      UPDATE public.muse_improvements
         SET status = 'VERIFICATION',
             verification_state = CASE weakest
               WHEN 3 THEN 'LIVE_VERIFIED' WHEN 2 THEN 'SYSTEM_VERIFIED'
               WHEN 1 THEN 'ARTIFACT_VERIFIED' ELSE 'CLAIMED' END
       WHERE id = parent.id;
    END IF;
  END IF;

  PERFORM set_config('muse.actor', prev_actor, true);
  PERFORM set_config('muse.note', prev_note, true);
  RETURN NULL;
END $$;

-- ===========================================================================
-- 11. MEASUREMENT DISCIPLINE
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.muse_measurements_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  parent public.muse_improvements%ROWTYPE;
  min_age interval;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'muse: measurements are append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Only the honesty label and notes may change (e.g. promotion to KNOWN
    -- once the number is verified). The measurement itself is history.
    IF (to_jsonb(NEW) - 'data_status' - 'notes' - 'updated_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'data_status' - 'notes' - 'updated_at') THEN
      RAISE EXCEPTION 'muse: measurements are append-only; record a new OTHER checkpoint instead'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF public.muse_actor_tier(NEW.recorded_by) IS NULL THEN
    RAISE EXCEPTION 'muse: recorded_by % is not a known actor', NEW.recorded_by USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO parent FROM public.muse_improvements WHERE id = NEW.improvement_id;
  IF parent.kind <> 'INTERVENTION' THEN
    RAISE EXCEPTION 'muse: only interventions are measured' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.checkpoint <> 'BASELINE' THEN
    IF parent.implemented_at IS NULL THEN
      RAISE EXCEPTION 'muse: % cannot be recorded before the change is implemented (improvement is %)', NEW.checkpoint, parent.status
        USING ERRCODE = 'check_violation';
    END IF;
    min_age := CASE NEW.checkpoint WHEN 'D7' THEN interval '7 days' WHEN 'D30' THEN interval '30 days' ELSE interval '0' END;
    IF NEW.measured_at < parent.implemented_at + min_age THEN
      RAISE EXCEPTION 'muse: % is not due until %', NEW.checkpoint, parent.implemented_at + min_age
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ===========================================================================
-- 12. TRIGGERS
-- ===========================================================================
DROP TRIGGER IF EXISTS muse_missions_guard ON public.muse_missions;
CREATE TRIGGER muse_missions_guard BEFORE INSERT OR UPDATE ON public.muse_missions
  FOR EACH ROW EXECUTE FUNCTION public.muse_missions_guard();

DROP TRIGGER IF EXISTS muse_improvements_guard ON public.muse_improvements;
CREATE TRIGGER muse_improvements_guard BEFORE INSERT OR UPDATE ON public.muse_improvements
  FOR EACH ROW EXECUTE FUNCTION public.muse_improvements_guard();

DROP TRIGGER IF EXISTS muse_improvement_tasks_guard ON public.muse_improvement_tasks;
CREATE TRIGGER muse_improvement_tasks_guard BEFORE INSERT OR UPDATE ON public.muse_improvement_tasks
  FOR EACH ROW EXECUTE FUNCTION public.muse_tasks_guard();

DROP TRIGGER IF EXISTS muse_improvement_tasks_advance ON public.muse_improvement_tasks;
CREATE TRIGGER muse_improvement_tasks_advance AFTER INSERT OR UPDATE OF state ON public.muse_improvement_tasks
  FOR EACH ROW EXECUTE FUNCTION public.muse_tasks_advance_parent();

DROP TRIGGER IF EXISTS muse_improvement_measurements_guard ON public.muse_improvement_measurements;
CREATE TRIGGER muse_improvement_measurements_guard BEFORE INSERT OR UPDATE OR DELETE ON public.muse_improvement_measurements
  FOR EACH ROW EXECUTE FUNCTION public.muse_measurements_guard();

-- History.
DROP TRIGGER IF EXISTS muse_missions_history ON public.muse_missions;
CREATE TRIGGER muse_missions_history AFTER INSERT OR UPDATE OF status ON public.muse_missions
  FOR EACH ROW EXECUTE FUNCTION public.muse_log_state_event();
DROP TRIGGER IF EXISTS muse_improvements_history ON public.muse_improvements;
CREATE TRIGGER muse_improvements_history AFTER INSERT OR UPDATE OF status ON public.muse_improvements
  FOR EACH ROW EXECUTE FUNCTION public.muse_log_state_event();
DROP TRIGGER IF EXISTS muse_improvement_tasks_history ON public.muse_improvement_tasks;
CREATE TRIGGER muse_improvement_tasks_history AFTER INSERT OR UPDATE OF state ON public.muse_improvement_tasks
  FOR EACH ROW EXECUTE FUNCTION public.muse_log_state_event();
DROP TRIGGER IF EXISTS muse_verifications_history ON public.muse_verifications;
CREATE TRIGGER muse_verifications_history AFTER INSERT OR UPDATE OF verification_state, failed_at ON public.muse_verifications
  FOR EACH ROW EXECUTE FUNCTION public.muse_log_state_event();

-- updated_at maintenance on the new tables (v1 function).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['muse_missions','muse_improvement_tasks','muse_improvement_measurements'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_touch', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.muse_touch_updated_at()',
      t || '_touch', t);
  END LOOP;
END $$;

-- ===========================================================================
-- 13. WRITE PROTOCOL — the only way state moves
-- ===========================================================================
-- SECURITY INVOKER: RLS and table grants still apply to the caller. The actor
-- is declared, not authenticated — see docs/MUSE_MISSION_BOARD.md §12.
CREATE OR REPLACE FUNCTION public.muse_transition_mission(
  p_id uuid, p_to text, p_actor text, p_note text DEFAULT NULL)
RETURNS public.muse_missions
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE r public.muse_missions;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' OR p_actor = 'system:auto' THEN
    RAISE EXCEPTION 'muse: an actor is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('muse.actor', p_actor, true);
  PERFORM set_config('muse.note', coalesce(p_note, ''), true);
  UPDATE public.muse_missions SET status = p_to WHERE id = p_id RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'muse: no mission %', p_id USING ERRCODE = 'no_data_found'; END IF;
  PERFORM set_config('muse.actor', '', true);
  PERFORM set_config('muse.note', '', true);
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.muse_transition_improvement(
  p_id uuid, p_to text, p_actor text, p_note text DEFAULT NULL,
  p_verdict text DEFAULT NULL, p_actual_result text DEFAULT NULL,
  p_next_iteration text DEFAULT NULL, p_collision_override text DEFAULT NULL)
RETURNS public.muse_improvements
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE r public.muse_improvements;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' OR p_actor = 'system:auto' THEN
    RAISE EXCEPTION 'muse: an actor is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('muse.actor', p_actor, true);
  PERFORM set_config('muse.note', coalesce(p_note, ''), true);
  UPDATE public.muse_improvements
     SET status = p_to,
         verdict = coalesce(p_verdict, verdict),
         actual_result = coalesce(p_actual_result, actual_result),
         next_iteration = coalesce(p_next_iteration, next_iteration),
         collision_override = coalesce(p_collision_override, collision_override)
   WHERE id = p_id
  RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'muse: no improvement %', p_id USING ERRCODE = 'no_data_found'; END IF;
  PERFORM set_config('muse.actor', '', true);
  PERFORM set_config('muse.note', '', true);
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.muse_transition_task(
  p_id uuid, p_to text, p_actor text, p_note text DEFAULT NULL,
  p_blocker text DEFAULT NULL, p_claimed_completion text DEFAULT NULL,
  p_evidence jsonb DEFAULT NULL, p_cancelled_reason text DEFAULT NULL)
RETURNS public.muse_improvement_tasks
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE r public.muse_improvement_tasks;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' OR p_actor = 'system:auto' THEN
    RAISE EXCEPTION 'muse: an actor is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_evidence IS NOT NULL AND jsonb_typeof(p_evidence) <> 'array' THEN
    RAISE EXCEPTION 'muse: evidence must be a JSON array' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('muse.actor', p_actor, true);
  PERFORM set_config('muse.note', coalesce(p_note, ''), true);
  UPDATE public.muse_improvement_tasks
     SET state = p_to,
         blocker = coalesce(p_blocker, blocker),
         claimed_completion = coalesce(p_claimed_completion, claimed_completion),
         evidence = evidence || coalesce(p_evidence, '[]'::jsonb),
         cancelled_reason = coalesce(p_cancelled_reason, cancelled_reason)
   WHERE id = p_id
  RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'muse: no task %', p_id USING ERRCODE = 'no_data_found'; END IF;
  PERFORM set_config('muse.actor', '', true);
  PERFORM set_config('muse.note', '', true);
  RETURN r;
END $$;

-- Record a verification result. Promotion needs evidence matching the level;
-- a failure sends the task back to its executor; meeting the requirement
-- completes the task. The claimant can never verify its own claim.
CREATE OR REPLACE FUNCTION public.muse_verify(
  p_verification_id uuid, p_verifier text, p_state text DEFAULT NULL,
  p_evidence_url text DEFAULT NULL, p_system_evidence text DEFAULT NULL,
  p_live_evidence text DEFAULT NULL, p_failure_reason text DEFAULT NULL,
  p_note text DEFAULT NULL)
RETURNS public.muse_verifications
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  v public.muse_verifications;
  t public.muse_improvement_tasks;
  target text;
BEGIN
  IF p_verifier IS NULL OR public.muse_actor_tier(p_verifier) IS NULL OR p_verifier = 'system:auto' THEN
    RAISE EXCEPTION 'muse: verifier % is not a known actor', p_verifier USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v FROM public.muse_verifications WHERE id = p_verification_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'muse: no verification %', p_verification_id USING ERRCODE = 'no_data_found'; END IF;
  IF v.failed_at IS NOT NULL THEN
    RAISE EXCEPTION 'muse: verification already failed; a new claim opens a new verification' USING ERRCODE = 'check_violation';
  END IF;
  IF p_verifier = v.claimed_by THEN
    RAISE EXCEPTION 'muse: % cannot verify its own claim', p_verifier USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM set_config('muse.actor', p_verifier, true);
  PERFORM set_config('muse.note', coalesce(p_note, ''), true);

  IF v.subject_type = 'improvement_task' THEN
    SELECT * INTO t FROM public.muse_improvement_tasks WHERE id = v.subject_ref::uuid;
  END IF;

  IF p_failure_reason IS NOT NULL THEN
    UPDATE public.muse_verifications
       SET failure_reason = p_failure_reason, failed_at = now(),
           verified_by = p_verifier, verified_at = now(),
           evidence_url = coalesce(p_evidence_url, evidence_url),
           system_evidence = coalesce(p_system_evidence, system_evidence),
           live_evidence = coalesce(p_live_evidence, live_evidence),
           notes = coalesce(p_note, notes)
     WHERE id = v.id RETURNING * INTO v;
    IF t.id IS NOT NULL AND t.state IN ('IMPLEMENTED','VERIFICATION') AND t.verification_id = v.id THEN
      UPDATE public.muse_improvement_tasks SET state = 'IN_PROGRESS' WHERE id = t.id;
    END IF;
  ELSE
    target := coalesce(p_state, v.verification_state);
    IF public.muse_verification_rank(target) < 0 THEN
      RAISE EXCEPTION 'muse: unknown verification state %', target USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF public.muse_verification_rank(target) < public.muse_verification_rank(v.verification_state) THEN
      RAISE EXCEPTION 'muse: verification never moves down (% -> %); record a failure instead', v.verification_state, target
        USING ERRCODE = 'check_violation';
    END IF;
    IF target = 'LIVE_VERIFIED' AND coalesce(p_live_evidence, v.live_evidence) IS NULL THEN
      RAISE EXCEPTION 'muse: LIVE_VERIFIED needs live_evidence' USING ERRCODE = 'check_violation';
    ELSIF target = 'SYSTEM_VERIFIED' AND coalesce(p_system_evidence, v.system_evidence, p_live_evidence, v.live_evidence) IS NULL THEN
      RAISE EXCEPTION 'muse: SYSTEM_VERIFIED needs system_evidence' USING ERRCODE = 'check_violation';
    ELSIF target = 'ARTIFACT_VERIFIED'
          AND coalesce(p_evidence_url, v.evidence_url, v.commit_sha, v.artifact_ref) IS NULL THEN
      RAISE EXCEPTION 'muse: ARTIFACT_VERIFIED needs an artifact (evidence_url, commit_sha or artifact_ref)'
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.muse_verifications
       SET verification_state = target, verified_by = p_verifier, verified_at = now(),
           evidence_url = coalesce(p_evidence_url, evidence_url),
           system_evidence = coalesce(p_system_evidence, system_evidence),
           live_evidence = coalesce(p_live_evidence, live_evidence),
           notes = coalesce(p_note, notes)
     WHERE id = v.id RETURNING * INTO v;

    IF t.id IS NOT NULL AND t.verification_id = v.id THEN
      IF t.state = 'IMPLEMENTED' THEN
        UPDATE public.muse_improvement_tasks SET state = 'VERIFICATION' WHERE id = t.id;
        t.state := 'VERIFICATION';
      END IF;
      IF t.state = 'VERIFICATION'
         AND public.muse_verification_rank(v.verification_state)
             >= public.muse_verification_rank(coalesce(v.required_state, t.verification_requirement, 'LIVE_VERIFIED')) THEN
        UPDATE public.muse_improvement_tasks SET state = 'COMPLETE' WHERE id = t.id;
      END IF;
    END IF;
  END IF;

  PERFORM set_config('muse.actor', '', true);
  PERFORM set_config('muse.note', '', true);
  RETURN v;
END $$;

-- ===========================================================================
-- 14. READ SURFACES
-- ===========================================================================
-- 1% / daily improvement ledger. v1 columns first, unchanged in order; new
-- columns appended (CREATE OR REPLACE VIEW can only append).
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
  (i.review_at IS NOT NULL AND i.review_at < now() AND i.verdict = 'PENDING'
     AND i.status NOT IN ('REJECTED','CLOSED')) AS review_due,
  (i.status = 'MEASURING' AND i.actual_result IS NULL AND NOT EXISTS (
     SELECT 1 FROM public.muse_improvement_measurements m
      WHERE m.improvement_id = i.id AND m.checkpoint <> 'BASELINE')) AS awaiting_measurement,
  CASE
    WHEN EXISTS (SELECT 1 FROM public.muse_improvement_measurements m
                  WHERE m.improvement_id = i.id AND m.checkpoint <> 'BASELINE' AND m.data_status = 'KNOWN')
      THEN 'KNOWN'
    WHEN i.actual_result IS NOT NULL AND i.verification_state IN ('SYSTEM_VERIFIED','LIVE_VERIFIED') THEN 'KNOWN'
    WHEN i.actual_result IS NOT NULL THEN 'NEEDS_VERIFICATION'
    WHEN EXISTS (SELECT 1 FROM public.muse_improvement_measurements m
                  WHERE m.improvement_id = i.id AND m.checkpoint <> 'BASELINE')
      THEN 'NEEDS_VERIFICATION'
    ELSE 'NOT_MEASURED'
  END AS data_status,
  i.created_at,
  now() AS as_of,
  -- v2 ---------------------------------------------------------------------
  i.kind,
  i.improvement_date,
  i.is_primary,
  i.function_area,
  i.observation,
  i.hypothesis,
  i.metric_key,
  public.muse_metric_norm(i.metric_key, i.metric) AS metric_norm,
  i.confidence,
  i.risk,
  i.reversibility,
  i.priority,
  i.recommended_executor,
  i.selected_by,
  i.selected_at,
  i.linked_mission_id,
  ms.title AS mission_title,
  i.linked_experiment_id,
  i.definition_of_done,
  i.verification_requirement,
  (public.muse_verification_rank(i.verification_state)
     >= public.muse_verification_rank(i.verification_requirement)) AS verification_met,
  i.owner_attention,
  (i.owner_attention IN ('APPROVAL','DECISION','DIRECT_INVOLVEMENT')
     AND i.approved_at IS NULL AND i.status = 'SELECTED') AS awaiting_owner,
  i.approved_by,
  i.approved_at,
  i.implemented_at,
  i.measurement_window_days,
  i.next_iteration,
  i.collision_override,
  (i.kind = 'INTERVENTION' AND i.status IN ('SELECTED','IN_EXECUTION','VERIFICATION','MEASURING')) AS is_active_experiment,
  coalesce(tk.open_tasks, 0) AS open_tasks,
  coalesce(tk.blocked_tasks, 0) AS blocked_tasks,
  coalesce(tk.completed_tasks, 0) AS completed_tasks,
  CASE
    WHEN tk.blocked_tasks > 0 THEN 'BLOCKED'
    WHEN tk.waiting_tasks > 0 THEN 'WAITING'
    WHEN tk.claimed_tasks > 0 THEN 'AWAITING_VERIFICATION'
    WHEN tk.open_tasks > 0 THEN 'IN_PROGRESS'
    WHEN tk.completed_tasks > 0 THEN 'TASKS_COMPLETE'
    ELSE 'NO_TASKS'
  END AS execution_state,
  coalesce(col.collision_count, 0) AS collision_count,
  col.collision_with,
  coalesce(own.same_function_open_tasks, 0) AS same_function_open_tasks,
  k.data_status AS metric_data_status,
  i.created_by,
  i.updated_by,
  i.updated_at
FROM public.muse_improvements i
JOIN public.muse_domains d ON d.key = i.domain_key
LEFT JOIN public.muse_missions ms ON ms.id = i.linked_mission_id
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE t.state NOT IN ('COMPLETE','CANCELLED')) AS open_tasks,
         count(*) FILTER (WHERE t.state = 'BLOCKED') AS blocked_tasks,
         count(*) FILTER (WHERE t.state = 'WAITING') AS waiting_tasks,
         count(*) FILTER (WHERE t.state IN ('IMPLEMENTED','VERIFICATION')) AS claimed_tasks,
         count(*) FILTER (WHERE t.state = 'COMPLETE') AS completed_tasks
    FROM public.muse_improvement_tasks t WHERE t.improvement_id = i.id
) tk ON true
-- Collision protection, readable before proposing: other live experiments on
-- the same metric in the same domain.
LEFT JOIN LATERAL (
  SELECT count(*) AS collision_count,
         string_agg(o.status || ': ' || o.intervention, ' | ' ORDER BY o.created_at) AS collision_with
    FROM public.muse_improvements o
   WHERE o.id <> i.id AND o.kind = 'INTERVENTION' AND o.domain_key = i.domain_key
     AND o.status IN ('SELECTED','IN_EXECUTION','VERIFICATION','MEASURING')
     AND public.muse_metric_norm(o.metric_key, o.metric) = public.muse_metric_norm(i.metric_key, i.metric)
) col ON true
-- Another agent already working the same function in the same domain.
LEFT JOIN LATERAL (
  SELECT count(*) AS same_function_open_tasks
    FROM public.muse_improvement_tasks t
    JOIN public.muse_improvements o ON o.id = t.improvement_id
   WHERE o.id <> i.id AND o.domain_key = i.domain_key
     AND i.function_area IS NOT NULL AND lower(o.function_area) = lower(i.function_area)
     AND t.state NOT IN ('COMPLETE','CANCELLED')
) own ON true
LEFT JOIN public.muse_kpi_summary k ON k.metric_key = i.metric_key;

COMMENT ON VIEW public.muse_improvement_ledger IS
  'Daily/1% improvement ledger: lifecycle, execution rollup, collision signals and measurement honesty. A verdict cannot be justified by an agent claim alone.';

-- Mission board.
CREATE OR REPLACE VIEW public.muse_mission_board AS
SELECT
  m.id,
  m.domain_key,
  d.name AS domain_name,
  m.title,
  m.objective,
  m.business_outcome,
  m.owner,
  m.executive_sponsor,
  m.priority,
  m.status,
  m.metric,
  m.metric_key,
  m.baseline,
  m.target,
  k.value AS current_value,
  k.unit AS current_unit,
  k.data_timestamp AS current_value_at,
  m.start_date,
  m.review_date,
  (m.review_date IS NOT NULL AND m.review_date < current_date
     AND m.status IN ('PROPOSED','ACTIVE','PAUSED')) AS review_overdue,
  m.dependencies,
  m.source_ref,
  m.evidence,
  m.owner_attention,
  m.created_by,
  m.updated_by,
  m.notes,
  (SELECT count(*) FROM public.muse_improvements i WHERE i.linked_mission_id = m.id) AS improvements_total,
  (SELECT count(*) FROM public.muse_improvements i WHERE i.linked_mission_id = m.id
     AND i.status IN ('SELECTED','IN_EXECUTION','VERIFICATION','MEASURING')) AS improvements_active,
  (SELECT count(*) FROM public.muse_improvements i WHERE i.linked_mission_id = m.id AND i.verdict = 'KEEP') AS improvements_kept,
  (SELECT count(*) FROM public.muse_improvements i WHERE i.linked_mission_id = m.id AND i.verdict = 'REVERSE') AS improvements_reversed,
  (SELECT count(*) FROM public.muse_improvement_tasks t
     JOIN public.muse_improvements i ON i.id = t.improvement_id
    WHERE i.linked_mission_id = m.id AND t.state NOT IN ('COMPLETE','CANCELLED')) AS open_tasks,
  CASE
    WHEN k.metric_key IS NOT NULL THEN k.data_status
    WHEN m.baseline IS NULL THEN 'NOT_MEASURED'
    ELSE 'NEEDS_VERIFICATION'
  END AS data_status,
  (k.metric_key IS NULL OR k.data_status <> 'KNOWN') AS human_verification_required,
  m.created_at,
  m.updated_at,
  now() AS as_of
FROM public.muse_missions m
JOIN public.muse_domains d ON d.key = m.domain_key
LEFT JOIN public.muse_kpi_summary k ON k.metric_key = m.metric_key;

COMMENT ON VIEW public.muse_mission_board IS
  'Portfolio objectives with live KPI (when registered and computable), linked improvements and open execution work.';

-- Agent queue.
CREATE OR REPLACE VIEW public.muse_agent_queue AS
SELECT
  t.id,
  t.improvement_id,
  i.intervention AS improvement_title,
  i.status AS improvement_status,
  i.improvement_date,
  i.domain_key,
  d.name AS domain_name,
  i.function_area,
  t.title,
  t.executor,
  s.name AS executor_name,
  t.assigned_by,
  t.objective,
  t.instructions,
  t.expected_artifact,
  t.definition_of_done,
  t.priority,
  CASE t.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 9 END AS priority_rank,
  t.due_at,
  t.state,
  t.blocker,
  t.evidence,
  t.claimed_completion,
  t.claimed_at,
  t.verification_requirement,
  t.verification_id,
  v.verification_state,
  v.verified_by,
  (v.failed_at IS NOT NULL) AS verification_failed,
  v.failure_reason AS verification_failure_reason,
  t.completed_at,
  t.cancelled_reason,
  (t.state NOT IN ('COMPLETE','CANCELLED')) AS is_open,
  (t.due_at IS NOT NULL AND t.due_at < now() AND t.state NOT IN ('COMPLETE','CANCELLED')) AS is_overdue,
  -- A task awaiting verification is a claim, not a fact.
  CASE WHEN t.state IN ('IMPLEMENTED','VERIFICATION') THEN 'NEEDS_VERIFICATION' ELSE 'KNOWN' END AS data_status,
  t.updated_by,
  t.created_at,
  t.updated_at,
  now() AS as_of
FROM public.muse_improvement_tasks t
JOIN public.muse_improvements i ON i.id = t.improvement_id
JOIN public.muse_domains d ON d.key = i.domain_key
LEFT JOIN public.muse_systems s ON s.key = t.executor
LEFT JOIN public.muse_verifications v ON v.id = t.verification_id;

COMMENT ON VIEW public.muse_agent_queue IS
  'Execution work per agent. Filter by executor for "my assigned tasks"; is_open excludes COMPLETE/CANCELLED.';

-- Verification queue.
CREATE OR REPLACE VIEW public.muse_verification_queue AS
SELECT
  v.id,
  v.subject_type,
  v.subject_ref,
  coalesce(t.title, v.subject_ref) AS subject_title,
  t.executor,
  t.state AS task_state,
  t.improvement_id,
  i.domain_key,
  v.claim,
  v.claimed_by AS claimant,
  v.claimed_at,
  v.verification_state,
  coalesce(v.required_state, 'LIVE_VERIFIED') AS required_state,
  (public.muse_verification_rank(v.verification_state)
     >= public.muse_verification_rank(coalesce(v.required_state, 'LIVE_VERIFIED'))
     AND v.failed_at IS NULL) AS meets_requirement,
  v.artifact_ref,
  v.repo,
  v.branch,
  v.commit_sha,
  v.evidence_url,
  v.system_evidence,
  v.live_evidence,
  v.verified_by AS verifier,
  v.verified_at,
  v.failure_reason,
  v.failed_at,
  CASE
    WHEN v.failed_at IS NOT NULL THEN 'FAILED'
    WHEN public.muse_verification_rank(v.verification_state)
         >= public.muse_verification_rank(coalesce(v.required_state, 'LIVE_VERIFIED')) THEN 'PASSED'
    ELSE 'PENDING'
  END AS queue_state,
  CASE
    WHEN v.failed_at IS NULL AND public.muse_verification_rank(v.verification_state)
         >= public.muse_verification_rank(coalesce(v.required_state, 'LIVE_VERIFIED')) THEN 'KNOWN'
    ELSE 'NEEDS_VERIFICATION'
  END AS data_status,
  (v.failed_at IS NULL AND public.muse_verification_rank(v.verification_state)
     < public.muse_verification_rank(coalesce(v.required_state, 'LIVE_VERIFIED'))) AS human_verification_required,
  v.notes,
  now() AS as_of
FROM public.muse_verifications v
LEFT JOIN public.muse_improvement_tasks t
  ON v.subject_type = 'improvement_task' AND t.id::text = v.subject_ref
LEFT JOIN public.muse_improvements i ON i.id = t.improvement_id;

COMMENT ON VIEW public.muse_verification_queue IS
  'Every claim with the level it must reach. PENDING until a verifier other than the claimant proves it; FAILED sends work back.';

-- Impact ledger.
CREATE OR REPLACE VIEW public.muse_impact_ledger AS
WITH m AS (
  SELECT
    improvement_id,
    max(metric_value) FILTER (WHERE checkpoint = 'BASELINE') AS baseline_value,
    max(metric_value) FILTER (WHERE checkpoint = 'IMMEDIATE') AS immediate_value,
    max(metric_value) FILTER (WHERE checkpoint = 'D7') AS d7_value,
    max(metric_value) FILTER (WHERE checkpoint = 'D30') AS d30_value,
    (array_agg(metric_value ORDER BY measured_at DESC)
       FILTER (WHERE checkpoint <> 'BASELINE' AND metric_value IS NOT NULL))[1] AS latest_value,
    (array_agg(coalesce(value_text, metric_value::text) ORDER BY measured_at DESC)
       FILTER (WHERE checkpoint <> 'BASELINE'))[1] AS latest_result,
    bool_or(checkpoint = 'D7') AS has_d7,
    bool_or(checkpoint = 'D30') AS has_d30,
    sum(financial_impact_usd) AS financial_impact_usd,
    sum(time_saved_minutes) AS time_saved_minutes,
    string_agg(unintended_consequences, ' | ' ORDER BY measured_at)
      FILTER (WHERE unintended_consequences IS NOT NULL) AS unintended_consequences,
    count(*) AS measurement_count,
    count(*) FILTER (WHERE checkpoint <> 'BASELINE') AS post_measurements,
    bool_and(data_status = 'KNOWN') FILTER (WHERE checkpoint <> 'BASELINE') AS all_post_known,
    max(measured_at) AS last_measured_at
  FROM public.muse_improvement_measurements
  GROUP BY improvement_id
)
SELECT
  i.id,
  i.domain_key,
  d.name AS domain_name,
  i.function_area,
  i.intervention,
  i.metric,
  i.metric_key,
  i.baseline,
  m.baseline_value,
  i.implemented_at,
  m.immediate_value,
  m.d7_value,
  m.d30_value,
  m.latest_value,
  m.latest_result,
  (m.latest_value - m.baseline_value) AS metric_delta,
  m.financial_impact_usd,
  m.time_saved_minutes,
  m.unintended_consequences,
  i.expected_result,
  i.actual_result,
  i.verdict,
  i.status,
  i.next_iteration,
  i.review_at,
  coalesce(m.measurement_count, 0) AS measurement_count,
  m.last_measured_at,
  (i.implemented_at IS NOT NULL AND i.implemented_at + interval '7 days' < now()
     AND NOT coalesce(m.has_d7, false) AND i.status = 'MEASURING') AS d7_due,
  (i.implemented_at IS NOT NULL AND i.implemented_at + interval '30 days' < now()
     AND NOT coalesce(m.has_d30, false) AND i.status = 'MEASURING') AS d30_due,
  CASE
    WHEN coalesce(m.post_measurements, 0) = 0 THEN 'NOT_MEASURED'
    WHEN m.all_post_known THEN 'KNOWN'
    ELSE 'NEEDS_VERIFICATION'
  END AS data_status,
  (coalesce(m.post_measurements, 0) = 0 OR NOT coalesce(m.all_post_known, false)) AS human_verification_required,
  i.created_at,
  now() AS as_of
FROM public.muse_improvements i
JOIN public.muse_domains d ON d.key = i.domain_key
LEFT JOIN m ON m.improvement_id = i.id
WHERE i.kind = 'INTERVENTION'
  AND (i.implemented_at IS NOT NULL OR i.status IN ('MEASURING','DECIDED','CLOSED'));

COMMENT ON VIEW public.muse_impact_ledger IS
  'Did it improve the business? Baseline vs immediate / 7-day / 30-day, delta, money and time, side effects, verdict and next iteration.';

-- Portfolio map: v1 columns unchanged in order; attention signals appended.
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
    WHERE il.domain_key = d.key
      AND il.status IN ('PROPOSED','SELECTED','IN_EXECUTION','VERIFICATION','MEASURING')) AS active_improvements,
  (SELECT count(*) FROM public.muse_system_health h
    WHERE h.domain_key = d.key AND h.status IN ('FAILING','STALE')) AS unhealthy_systems,
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
  now() AS as_of,
  -- v2: portfolio rotation --------------------------------------------------
  att.last_improvement_at,
  coalesce(att.improvements_30d, 0) AS improvements_30d,
  coalesce(att.active_experiments, 0) AS active_experiments,
  (SELECT count(*) FROM public.muse_improvement_tasks t
     JOIN public.muse_improvements i ON i.id = t.improvement_id
    WHERE i.domain_key = d.key AND t.state NOT IN ('COMPLETE','CANCELLED')) AS open_tasks,
  (SELECT count(*) FROM public.muse_missions ms
    WHERE ms.domain_key = d.key AND ms.status = 'ACTIVE') AS active_missions,
  -- UNDER_ATTENDED is a flag for Muse, never an instruction to invent work.
  -- It needs 30 days of daily-board history before it can say anything.
  CASE
    WHEN board.started_at IS NULL OR board.started_at > now() - interval '30 days' THEN 'INSUFFICIENT_HISTORY'
    WHEN att.last_improvement_at IS NOT NULL AND att.last_improvement_at > now() - interval '30 days' THEN 'ATTENDED'
    WHEN d.current_bottleneck IS NOT NULL OR EXISTS (
      SELECT 1 FROM public.muse_open_loops_live l
       WHERE l.domain_key = d.key AND l.state NOT IN ('RESOLVED','CANCELLED')) THEN 'UNDER_ATTENDED'
    ELSE 'QUIET'
  END AS attention_flag
FROM public.muse_domains d
LEFT JOIN LATERAL (
  SELECT max(greatest(i.created_at, coalesce(i.selected_at, i.created_at))) AS last_improvement_at,
         count(*) FILTER (WHERE i.created_at > now() - interval '30 days') AS improvements_30d,
         count(*) FILTER (WHERE i.kind = 'INTERVENTION'
                            AND i.status IN ('SELECTED','IN_EXECUTION','VERIFICATION','MEASURING')) AS active_experiments
    FROM public.muse_improvements i
   WHERE i.domain_key = d.key AND i.status <> 'REJECTED'
) att ON true
CROSS JOIN LATERAL (
  SELECT min(i.created_at) AS started_at FROM public.muse_improvements i WHERE i.improvement_date IS NOT NULL
) board
WHERE d.is_active;

-- Executive brief: v1 sections, plus three board-derived feeds routed into the
-- existing sections (no new section vocabulary).
CREATE OR REPLACE VIEW public.muse_executive_brief AS
WITH items AS (
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

  -- v2: board feeds ---------------------------------------------------------
  UNION ALL
  -- Only work Muse has already SELECTED reaches Fendi, and only when its
  -- owner-attention budget says it needs him.
  SELECT 'decisions_required', CASE WHEN i.risk = 'HIGH' THEN 'P0' ELSE 'P1' END,
         coalesce(i.review_at, now() + interval '100 years'),
         'Approve improvement: ' || i.intervention, i.domain_key, i.domain_name,
         coalesce(i.hypothesis, i.problem) || ' [' || i.owner_attention || ', risk '
           || coalesce(i.risk, '?') || ', ' || coalesce(i.reversibility, '?') || ']',
         'FENDI_DECISION', 'Fendi', i.review_at,
         'muse_board', i.id::text, i.data_status, i.verification_state,
         i.id::text, 'improvement'
  FROM public.muse_improvement_ledger i
  WHERE i.awaiting_owner

  UNION ALL
  SELECT 'blockers', t.priority,
         coalesce(t.due_at, now() + interval '100 years'),
         'Task blocked: ' || t.title, t.domain_key, t.domain_name,
         coalesce(t.blocker, 'Blocker not described'),
         'DELEGATE_TO_AGENT', t.executor, t.due_at,
         'muse_board', t.improvement_id::text, t.data_status, coalesce(t.verification_state, 'CLAIMED'),
         t.id::text, 'task'
  FROM public.muse_agent_queue t
  WHERE t.state = 'BLOCKED'

  UNION ALL
  SELECT 'priorities', 'P1',
         coalesce(i.review_at, now()),
         'Experiment review due: ' || i.intervention, i.domain_key, i.domain_name,
         'Measure ' || i.metric || ' and record KEEP / REVISE / REVERSE / INCONCLUSIVE',
         'MUSE_ANALYSIS', 'Muse', i.review_at,
         'muse_board', i.id::text, i.data_status, i.verification_state,
         i.id::text, 'improvement'
  FROM public.muse_improvement_ledger i
  WHERE i.status = 'MEASURING' AND i.review_due
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

-- ===========================================================================
-- 15. ROW LEVEL SECURITY + PRIVILEGES (new objects only)
-- ===========================================================================
ALTER TABLE public.muse_missions                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_improvement_tasks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_improvement_measurements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_state_events              ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['muse_missions','muse_improvement_tasks','muse_improvement_measurements'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated full access" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "Authenticated full access" ON public.%I FOR ALL TO authenticated USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL)', t);
    EXECUTE format('DROP POLICY IF EXISTS "Service role full access" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "Service role full access" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

-- History is read-only to everyone; only the SECURITY DEFINER trigger writes it.
DROP POLICY IF EXISTS "Authenticated read history" ON public.muse_state_events;
CREATE POLICY "Authenticated read history" ON public.muse_state_events
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "Service role read history" ON public.muse_state_events;
CREATE POLICY "Service role read history" ON public.muse_state_events
  FOR SELECT TO service_role USING (true);
REVOKE ALL ON public.muse_state_events FROM anon, PUBLIC, authenticated, service_role;
GRANT SELECT ON public.muse_state_events TO authenticated, service_role;
REVOKE ALL ON SEQUENCE public.muse_state_events_id_seq FROM anon, PUBLIC, authenticated;

-- Views: operator, service role and the read-only muse_reader role.
DO $$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['muse_mission_board','muse_agent_queue','muse_verification_queue',
                           'muse_impact_ledger','muse_improvement_ledger','muse_portfolio_map',
                           'muse_executive_brief'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', v);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', v);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', v);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'muse_reader') THEN
      EXECUTE format('GRANT SELECT ON public.%I TO muse_reader', v);
    END IF;
  END LOOP;
END $$;

-- Functions: never anon, never muse_reader. Trigger functions are not callable
-- directly anyway; the write protocol is for the operator and service role.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.muse_transition_mission(uuid, text, text, text)',
    'public.muse_transition_improvement(uuid, text, text, text, text, text, text, text)',
    'public.muse_transition_task(uuid, text, text, text, text, text, jsonb, text)',
    'public.muse_verify(uuid, text, text, text, text, text, text, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.muse_log_state_event()', 'public.muse_missions_guard()', 'public.muse_improvements_guard()',
    'public.muse_tasks_guard()', 'public.muse_tasks_advance_parent()', 'public.muse_measurements_guard()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
  END LOOP;
  -- Helpers run inside the operator's triggers, so authenticated keeps them.
  FOREACH f IN ARRAY ARRAY[
    'public.muse_verification_rank(text)', 'public.muse_metric_norm(text, text)',
    'public.muse_current_actor()', 'public.muse_actor_tier(text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role, muse_reader', f);
  END LOOP;
END $$;

-- ===========================================================================
-- 16. SEED — deployment tracking only (no business content invented)
-- ===========================================================================
INSERT INTO public.muse_open_loops
  (domain_key, title, owner, state, classification, category, priority, dependency,
   source, source_ref, last_evidence_at, next_action, review_at, verification_state, notes)
SELECT v.* FROM (VALUES
  ('ai_technical_systems',
   'Mission board v2: apply migration in Lovable SQL editor, redeploy muse-executive, publish',
   'Fendi', 'IN_PROGRESS', 'HUMAN_OWNER', 'SYSTEM', 'P1',
   'Lovable SQL editor (schema) + Edge Functions redeploy (API) + Publish (UI)',
   'muse_v2_build', 'supabase/migrations/20260927120000_muse_mission_board.sql',
   now(),
   'Follow docs/HANDOFF_MUSE_MISSION_BOARD_DEPLOY.md',
   now() + interval '3 days', 'CLAIMED',
   'Code in GitHub is CODED, not LIVE. Closes only when the handoff''s verification passes.')
) AS v(domain_key, title, owner, state, classification, category, priority, dependency,
       source, source_ref, last_evidence_at, next_action, review_at, verification_state, notes)
WHERE NOT EXISTS (SELECT 1 FROM public.muse_open_loops l WHERE l.title = v.title);

INSERT INTO public.muse_verifications
  (subject_type, subject_ref, claim, verification_state, claimed_by, repo, branch, required_state, notes)
SELECT v.* FROM (VALUES
  ('migration', '20260927120000_muse_mission_board.sql',
   'Mission board / daily improvement / agent queue / verification queue / impact ledger schema authored',
   'CLAIMED', 'claude-code', 'fendifrost-dot/fendi-control-center', 'claude/control-center-mission-board-j4xh9m',
   'LIVE_VERIFIED',
   'Validated against a local PostgreSQL 16 harness (scripts/muse/verify-muse-board-sql.sql). Not applied to the live database by this claim.'),
  ('ui_module', '/muse (mission board v2)',
   'Mission board, daily improvement, agent queue, verification and impact ledger surfaces added',
   'CLAIMED', 'claude-code', 'fendifrost-dot/fendi-control-center', 'claude/control-center-mission-board-j4xh9m',
   'LIVE_VERIFIED', 'Requires a Lovable publish before it is live.')
) AS v(subject_type, subject_ref, claim, verification_state, claimed_by, repo, branch, required_state, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.muse_verifications mv
  WHERE mv.subject_type = v.subject_type AND mv.subject_ref = v.subject_ref
);
