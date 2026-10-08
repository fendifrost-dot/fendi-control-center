-- Daily operating reports for Grok Bot and Enki.
--
-- Start-of-day and end-of-day reports were appended as STATUS updates on a
-- stand-in mission because muse_work_updates requires a parent id. This table
-- is that parent. It does not modify mission 6f14b53d-4c16-49ec-a475-a1bf94229499
-- or the STATUS rows already written there.

CREATE TABLE IF NOT EXISTS public.muse_daily_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date date NOT NULL,
  cadence text NOT NULL
    CONSTRAINT muse_daily_reports_cadence_check CHECK (cadence IN ('START_OF_DAY', 'END_OF_DAY')),
  actor text NOT NULL,
  message text NOT NULL,
  sections jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS muse_daily_reports_date_idx
  ON public.muse_daily_reports (report_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS muse_daily_reports_actor_cadence_idx
  ON public.muse_daily_reports (actor, cadence, report_date DESC);

ALTER TABLE public.muse_daily_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read daily reports" ON public.muse_daily_reports;
CREATE POLICY "Authenticated read daily reports" ON public.muse_daily_reports
  FOR SELECT TO authenticated
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated append daily reports" ON public.muse_daily_reports;
CREATE POLICY "Authenticated append daily reports" ON public.muse_daily_reports
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Service role full access" ON public.muse_daily_reports;
CREATE POLICY "Service role full access" ON public.muse_daily_reports
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.muse_daily_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.muse_daily_reports TO authenticated;
GRANT ALL ON public.muse_daily_reports TO service_role;
REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.muse_daily_reports FROM authenticated;

COMMENT ON TABLE public.muse_daily_reports IS
  'Append-only start-of-day and end-of-day reports. Signed-in operators may read and append; they cannot rewrite history. Service role is reserved for muse-workboard.';

-- The writer audits every action. record_daily_report must be allowed or a
-- successful insert is followed by a failed audit row.
ALTER TABLE public.muse_workboard_requests
  DROP CONSTRAINT IF EXISTS muse_workboard_requests_action_check;

ALTER TABLE public.muse_workboard_requests
  ADD CONSTRAINT muse_workboard_requests_action_check CHECK (action IN (
    'create_mission',
    'create_improvement',
    'create_task',
    'append_update',
    'record_measurement',
    'update_task_state',
    'update_task_verification',
    'update_improvement_state',
    'record_daily_report'
  ));

CREATE OR REPLACE VIEW public.muse_daily_report_board AS
SELECT
  r.id,
  r.report_date,
  r.cadence,
  r.actor,
  r.message,
  r.sections,
  r.evidence_ref,
  r.created_at,
  now() AS as_of
FROM public.muse_daily_reports r;

COMMENT ON VIEW public.muse_daily_report_board IS
  'Daily start-of-day and end-of-day reports. Newest row for an actor, date, and cadence is the current report; older rows stay as history.';

REVOKE ALL ON public.muse_daily_report_board FROM anon, PUBLIC;
GRANT SELECT ON public.muse_daily_report_board TO authenticated, service_role, muse_reader;
