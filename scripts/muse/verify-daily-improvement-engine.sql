\echo '== Muse Daily Improvement Engine verification =='

DO $$
DECLARE
  missing integer;
BEGIN
  SELECT count(*) INTO missing
  FROM (VALUES
    ('muse_missions'),
    ('muse_improvement_tasks'),
    ('muse_improvement_measurements'),
    ('muse_work_updates'),
    ('muse_daily_reports')
  ) AS expected(name)
  WHERE to_regclass('public.' || expected.name) IS NULL;
  IF missing <> 0 THEN
    RAISE EXCEPTION '% required workboard tables missing', missing;
  END IF;
END $$;

DO $$
DECLARE
  missing integer;
BEGIN
  SELECT count(*) INTO missing
  FROM (VALUES
    ('muse_mission_board'),
    ('muse_daily_improvement_board'),
    ('muse_agent_queue'),
    ('muse_verification_queue'),
    ('muse_improvement_results'),
    ('muse_work_feed'),
    ('muse_daily_report_board')
  ) AS expected(name)
  WHERE to_regclass('public.' || expected.name) IS NULL;
  IF missing <> 0 THEN
    RAISE EXCEPTION '% required workboard views missing', missing;
  END IF;
END $$;

-- The work feed must be append-only to authenticated users.
DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.muse_work_updates', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.muse_work_updates', 'DELETE')
     OR has_table_privilege('authenticated', 'public.muse_work_updates', 'TRUNCATE') THEN
    RAISE EXCEPTION 'authenticated may rewrite muse_work_updates; append-only invariant broken';
  END IF;
  IF has_table_privilege('authenticated', 'public.muse_daily_reports', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.muse_daily_reports', 'DELETE')
     OR has_table_privilege('authenticated', 'public.muse_daily_reports', 'TRUNCATE') THEN
    RAISE EXCEPTION 'authenticated may rewrite muse_daily_reports; append-only invariant broken';
  END IF;
  -- TRUNCATE bypasses RLS, so it must be checked explicitly on every append-only table.
  IF has_table_privilege('authenticated', 'public.muse_access_audit', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.muse_access_audit', 'DELETE')
     OR has_table_privilege('authenticated', 'public.muse_access_audit', 'TRUNCATE') THEN
    RAISE EXCEPTION 'authenticated may rewrite muse_access_audit; audit trail invariant broken';
  END IF;
END $$;

-- Closed executive API views must remain selectable by muse_reader.
DO $$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY[
    'muse_mission_board','muse_daily_improvement_board','muse_agent_queue',
    'muse_verification_queue','muse_improvement_results','muse_work_feed',
    'muse_daily_report_board'
  ] LOOP
    IF NOT has_table_privilege('muse_reader', 'public.' || v, 'SELECT') THEN
      RAISE EXCEPTION 'muse_reader lacks SELECT on %', v;
    END IF;
  END LOOP;
END $$;

\echo 'Daily Improvement Engine schema checks passed.'
