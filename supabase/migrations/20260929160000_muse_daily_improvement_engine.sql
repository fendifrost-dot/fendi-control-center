-- ============================================================================
-- MUSE DAILY IMPROVEMENT ENGINE
-- Structured cross-agent operating board for Muse -> Grok -> Claude/specialists.
-- Additive only. Domain systems remain authoritative for operational truth.
-- ============================================================================

-- 1. Mission board: objectives sit above implementation tasks.
CREATE TABLE IF NOT EXISTS public.muse_missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_key text NOT NULL REFERENCES public.muse_domains(key) ON UPDATE CASCADE,
  title text NOT NULL,
  objective text NOT NULL,
  business_outcome text,
  owner text NOT NULL DEFAULT 'Muse',
  executive_sponsor text NOT NULL DEFAULT 'Fendi',
  priority text NOT NULL DEFAULT 'P2'
    CONSTRAINT muse_missions_priority_check CHECK (priority IN ('P0','P1','P2','P3')),
  status text NOT NULL DEFAULT 'ACTIVE'
    CONSTRAINT muse_missions_status_check CHECK (status IN ('PROPOSED','ACTIVE','PAUSED','COMPLETE','CANCELLED')),
  metric text,
  baseline text,
  target text,
  started_at timestamptz,
  review_at timestamptz,
  dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_ref text,
  created_by text NOT NULL DEFAULT 'Muse',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS muse_missions_domain_status_idx
  ON public.muse_missions(domain_key, status, priority);

-- 2. Extend the existing 1% ledger instead of creating a competing improvement table.
ALTER TABLE public.muse_improvements
  ADD COLUMN IF NOT EXISTS improvement_date date,
  ADD COLUMN IF NOT EXISTS function_name text,
  ADD COLUMN IF NOT EXISTS observation text,
  ADD COLUMN IF NOT EXISTS hypothesis text,
  ADD COLUMN IF NOT EXISTS confidence text,
  ADD COLUMN IF NOT EXISTS risk text,
  ADD COLUMN IF NOT EXISTS reversible boolean,
  ADD COLUMN IF NOT EXISTS priority text,
  ADD COLUMN IF NOT EXISTS recommended_executor text,
  ADD COLUMN IF NOT EXISTS selected_by text,
  ADD COLUMN IF NOT EXISTS mission_id uuid REFERENCES public.muse_missions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS definition_of_done text,
  ADD COLUMN IF NOT EXISTS verification_requirement text,
  ADD COLUMN IF NOT EXISTS owner_attention text,
  ADD COLUMN IF NOT EXISTS expected_impact text,
  ADD COLUMN IF NOT EXISTS observe_only_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'muse_improvements_confidence_check'
      AND conrelid = 'public.muse_improvements'::regclass
  ) THEN
    ALTER TABLE public.muse_improvements
      ADD CONSTRAINT muse_improvements_confidence_check
      CHECK (confidence IS NULL OR confidence IN ('HIGH','MEDIUM','LOW'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'muse_improvements_priority_check'
      AND conrelid = 'public.muse_improvements'::regclass
  ) THEN
    ALTER TABLE public.muse_improvements
      ADD CONSTRAINT muse_improvements_priority_check
      CHECK (priority IS NULL OR priority IN ('P0','P1','P2','P3'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'muse_improvements_owner_attention_check'
      AND conrelid = 'public.muse_improvements'::regclass
  ) THEN
    ALTER TABLE public.muse_improvements
      ADD CONSTRAINT muse_improvements_owner_attention_check
      CHECK (owner_attention IS NULL OR owner_attention IN ('NONE','INFORM','APPROVAL','DECISION','DIRECT_INVOLVEMENT'));
  END IF;
END $$;

-- 3. Agent queue: one improvement may generate several execution tasks.
CREATE TABLE IF NOT EXISTS public.muse_improvement_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  improvement_id uuid NOT NULL REFERENCES public.muse_improvements(id) ON DELETE CASCADE,
  domain_key text NOT NULL REFERENCES public.muse_domains(key) ON UPDATE CASCADE,
  title text NOT NULL,
  executor text NOT NULL,
  assigning_agent text NOT NULL DEFAULT 'Grok Bot',
  objective text,
  instructions text,
  expected_artifact text,
  definition_of_done text,
  priority text NOT NULL DEFAULT 'P2'
    CONSTRAINT muse_improvement_tasks_priority_check CHECK (priority IN ('P0','P1','P2','P3')),
  state text NOT NULL DEFAULT 'ASSIGNED'
    CONSTRAINT muse_improvement_tasks_state_check CHECK (state IN (
      'ASSIGNED','IN_PROGRESS','WAITING','BLOCKED','IMPLEMENTED','VERIFICATION','COMPLETE','CANCELLED')),
  blocker text,
  due_at timestamptz,
  claimed_completed_at timestamptz,
  verification_state text NOT NULL DEFAULT 'CLAIMED'
    CONSTRAINT muse_improvement_tasks_verification_check CHECK (verification_state IN (
      'CLAIMED','ARTIFACT_VERIFIED','SYSTEM_VERIFIED','LIVE_VERIFIED')),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS muse_improvement_tasks_executor_state_idx
  ON public.muse_improvement_tasks(executor, state, priority);
CREATE INDEX IF NOT EXISTS muse_improvement_tasks_improvement_idx
  ON public.muse_improvement_tasks(improvement_id);

-- 4. Measurements make "completed" distinct from "improved the business".
CREATE TABLE IF NOT EXISTS public.muse_improvement_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  improvement_id uuid NOT NULL REFERENCES public.muse_improvements(id) ON DELETE CASCADE,
  measurement_type text NOT NULL
    CONSTRAINT muse_improvement_measurements_type_check CHECK (measurement_type IN (
      'BASELINE','IMMEDIATE','DAY_7','DAY_30','CUSTOM')),
  measured_at timestamptz NOT NULL DEFAULT now(),
  metric text NOT NULL,
  value_text text,
  value_numeric numeric,
  unit text,
  delta_text text,
  financial_impact numeric,
  time_saved_minutes numeric,
  unintended_consequences text,
  evidence_ref text,
  verification_state text NOT NULL DEFAULT 'CLAIMED'
    CONSTRAINT muse_improvement_measurements_verification_check CHECK (verification_state IN (
      'CLAIMED','ARTIFACT_VERIFIED','SYSTEM_VERIFIED','LIVE_VERIFIED')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT muse_improvement_measurements_one_value CHECK (value_text IS NOT NULL OR value_numeric IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS muse_improvement_measurements_improvement_at_idx
  ON public.muse_improvement_measurements(improvement_id, measured_at DESC);

-- 5. Append-only work feed: agents communicate through state, with concise evidence-backed updates.
CREATE TABLE IF NOT EXISTS public.muse_work_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_key text REFERENCES public.muse_domains(key) ON UPDATE CASCADE,
  mission_id uuid REFERENCES public.muse_missions(id) ON DELETE CASCADE,
  improvement_id uuid REFERENCES public.muse_improvements(id) ON DELETE CASCADE,
  task_id uuid REFERENCES public.muse_improvement_tasks(id) ON DELETE CASCADE,
  actor text NOT NULL,
  update_type text NOT NULL
    CONSTRAINT muse_work_updates_type_check CHECK (update_type IN (
      'NOTE','ASSIGNMENT','STATUS','BLOCKER','EVIDENCE','DECISION','MEASUREMENT')),
  message text NOT NULL,
  evidence_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT muse_work_updates_parent_check CHECK (
    mission_id IS NOT NULL OR improvement_id IS NOT NULL OR task_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS muse_work_updates_created_idx
  ON public.muse_work_updates(created_at DESC);

-- 6. RLS and operator/service-role policy model mirrors the existing Muse layer.
ALTER TABLE public.muse_missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_improvement_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_improvement_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_work_updates ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'muse_missions','muse_improvement_tasks','muse_improvement_measurements','muse_work_updates'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated full access" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "Authenticated full access" ON public.%I FOR ALL TO authenticated USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL)', t);
    EXECUTE format('DROP POLICY IF EXISTS "Service role full access" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "Service role full access" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['muse_missions','muse_improvement_tasks'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_touch', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.muse_touch_updated_at()',
      t || '_touch', t);
  END LOOP;
END $$;

-- 7. Curated read surfaces.
CREATE OR REPLACE VIEW public.muse_mission_board AS
SELECT
  m.id, m.domain_key, d.name AS domain_name, m.title, m.objective, m.business_outcome,
  m.owner, m.executive_sponsor, m.priority, m.status, m.metric, m.baseline, m.target,
  m.started_at, m.review_at, m.dependencies, m.source_ref, m.created_by, m.notes,
  m.created_at, m.updated_at,
  count(i.id) FILTER (WHERE i.status IN ('PROPOSED','RUNNING','MEASURED')) AS active_improvements,
  count(t.id) FILTER (WHERE t.state IN ('ASSIGNED','IN_PROGRESS','WAITING','BLOCKED','IMPLEMENTED','VERIFICATION')) AS active_tasks,
  count(t.id) FILTER (WHERE t.state = 'BLOCKED') AS blocked_tasks,
  now() AS as_of
FROM public.muse_missions m
JOIN public.muse_domains d ON d.key = m.domain_key
LEFT JOIN public.muse_improvements i ON i.mission_id = m.id
LEFT JOIN public.muse_improvement_tasks t ON t.improvement_id = i.id
GROUP BY m.id, d.name;

CREATE OR REPLACE VIEW public.muse_daily_improvement_board AS
SELECT
  i.id, i.domain_key, d.name AS domain_name, i.improvement_date,
  i.function_name, i.observation, i.problem, i.intervention, i.hypothesis,
  i.baseline, i.metric, i.expected_impact, i.expected_result, i.actual_result,
  i.confidence, i.risk, i.reversible, i.priority, i.owner, i.recommended_executor,
  i.selected_by, i.mission_id, m.title AS mission_title,
  i.definition_of_done, i.verification_requirement, i.owner_attention,
  i.observe_only_reason, i.started_at, i.review_at, i.status, i.verdict,
  i.verification_state, i.source_ref, i.notes, i.created_at,
  count(t.id) AS task_count,
  count(t.id) FILTER (WHERE t.state = 'COMPLETE') AS tasks_complete,
  count(t.id) FILTER (WHERE t.state = 'BLOCKED') AS tasks_blocked,
  count(mm.id) AS measurement_count,
  (i.review_at IS NOT NULL AND i.review_at <= now() AND i.status NOT IN ('CLOSED')) AS review_due,
  now() AS as_of
FROM public.muse_improvements i
JOIN public.muse_domains d ON d.key = i.domain_key
LEFT JOIN public.muse_missions m ON m.id = i.mission_id
LEFT JOIN public.muse_improvement_tasks t ON t.improvement_id = i.id
LEFT JOIN public.muse_improvement_measurements mm ON mm.improvement_id = i.id
GROUP BY i.id, d.name, m.title;

CREATE OR REPLACE VIEW public.muse_agent_queue AS
SELECT
  t.id, t.improvement_id, t.domain_key, d.name AS domain_name,
  i.intervention AS improvement, t.title, t.executor, t.assigning_agent,
  t.objective, t.instructions, t.expected_artifact, t.definition_of_done,
  t.priority, t.state, t.blocker, t.due_at, t.claimed_completed_at,
  t.verification_state, t.evidence, t.source_ref, t.created_at, t.updated_at,
  (t.due_at IS NOT NULL AND t.due_at < now() AND t.state NOT IN ('COMPLETE','CANCELLED')) AS overdue,
  now() AS as_of
FROM public.muse_improvement_tasks t
JOIN public.muse_improvements i ON i.id = t.improvement_id
JOIN public.muse_domains d ON d.key = t.domain_key;

CREATE OR REPLACE VIEW public.muse_verification_queue AS
SELECT
  t.id AS task_id, t.improvement_id, t.domain_key, d.name AS domain_name,
  t.title, t.executor AS claimant, t.verification_state,
  t.claimed_completed_at, t.expected_artifact, t.definition_of_done,
  t.evidence, t.source_ref, i.verification_requirement,
  now() AS as_of
FROM public.muse_improvement_tasks t
JOIN public.muse_improvements i ON i.id = t.improvement_id
JOIN public.muse_domains d ON d.key = t.domain_key
WHERE t.state IN ('IMPLEMENTED','VERIFICATION') OR
      (t.state = 'COMPLETE' AND t.verification_state <> 'LIVE_VERIFIED');

CREATE OR REPLACE VIEW public.muse_improvement_results AS
SELECT
  i.id AS improvement_id, i.domain_key, d.name AS domain_name,
  i.intervention, i.metric, i.baseline, i.actual_result, i.verdict, i.status,
  i.verification_state, i.started_at, i.review_at,
  max(mm.measured_at) AS latest_measurement_at,
  (array_agg(mm.measurement_type ORDER BY mm.measured_at DESC) FILTER (WHERE mm.id IS NOT NULL))[1] AS latest_measurement_type,
  (array_agg(coalesce(mm.value_text, mm.value_numeric::text) ORDER BY mm.measured_at DESC) FILTER (WHERE mm.id IS NOT NULL))[1] AS latest_value,
  (array_agg(mm.delta_text ORDER BY mm.measured_at DESC) FILTER (WHERE mm.id IS NOT NULL))[1] AS latest_delta,
  coalesce(sum(mm.financial_impact), 0) AS recorded_financial_impact,
  coalesce(sum(mm.time_saved_minutes), 0) AS recorded_time_saved_minutes,
  count(mm.id) AS measurement_count,
  now() AS as_of
FROM public.muse_improvements i
JOIN public.muse_domains d ON d.key = i.domain_key
LEFT JOIN public.muse_improvement_measurements mm ON mm.improvement_id = i.id
GROUP BY i.id, d.name;

CREATE OR REPLACE VIEW public.muse_work_feed AS
SELECT
  u.id, u.domain_key, d.name AS domain_name, u.mission_id, u.improvement_id, u.task_id,
  u.actor, u.update_type, u.message, u.evidence_ref, u.created_at, now() AS as_of
FROM public.muse_work_updates u
LEFT JOIN public.muse_domains d ON d.key = u.domain_key;

-- 8. Explicit privileges: browser operator can curate tables; API/reader only sees views.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN (
        'muse_missions','muse_improvement_tasks','muse_improvement_measurements','muse_work_updates',
        'muse_mission_board','muse_daily_improvement_board','muse_agent_queue',
        'muse_verification_queue','muse_improvement_results','muse_work_feed'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', r.relname);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', r.relname);
    IF r.relkind = 'v' THEN
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role, muse_reader', r.relname);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', r.relname);
      EXECUTE format('GRANT ALL ON public.%I TO service_role', r.relname);
    END IF;
  END LOOP;
END $$;

COMMENT ON VIEW public.muse_mission_board IS 'Portfolio objectives above implementation work.';
COMMENT ON VIEW public.muse_daily_improvement_board IS 'Daily 1% candidates and active interventions, including OBSERVE/no-change states.';
COMMENT ON VIEW public.muse_agent_queue IS 'Structured task queue for Grok, Claude and future specialist agents.';
COMMENT ON VIEW public.muse_verification_queue IS 'Completion claims requiring stronger evidence before closure.';
COMMENT ON VIEW public.muse_improvement_results IS 'Measured impact ledger; completion and business improvement remain distinct.';
COMMENT ON VIEW public.muse_work_feed IS 'Append-only cross-agent update feed. State remains authoritative; prose is supporting evidence.';
