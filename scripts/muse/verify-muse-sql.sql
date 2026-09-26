-- ---------------------------------------------------------------------------
-- Muse v1 schema verification. Every check RAISEs on failure, so a clean run
-- means every assertion held. Run via scripts/muse/verify-muse-sql.sh.
-- ---------------------------------------------------------------------------
\set ON_ERROR_STOP on
\timing off

\echo '== A. structure =='
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
   WHERE ns.nspname='public' AND c.relname LIKE 'muse\_%' AND c.relkind='r';
  IF n <> 11 THEN RAISE EXCEPTION 'expected 11 muse tables, found %', n; END IF;
  RAISE NOTICE 'PASS: % muse tables', n;

  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
   WHERE ns.nspname='public' AND c.relname LIKE 'muse\_%' AND c.relkind='v';
  IF n <> 11 THEN RAISE EXCEPTION 'expected 11 muse views, found %', n; END IF;
  RAISE NOTICE 'PASS: % muse views', n;

  -- No existing Control Hub object may have been altered by this migration.
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
   WHERE ns.nspname='public' AND c.relkind='v' AND c.relname NOT LIKE 'muse\_%';
  IF n <> 0 THEN RAISE EXCEPTION 'migration created % non-muse view(s)', n; END IF;
  RAISE NOTICE 'PASS: no non-muse views created';
END $$;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_tables
   WHERE schemaname='public' AND tablename LIKE 'muse\_%' AND NOT rowsecurity;
  IF n <> 0 THEN RAISE EXCEPTION '% muse table(s) without RLS', n; END IF;
  RAISE NOTICE 'PASS: RLS enabled on every muse table';
END $$;

\echo '== B. seeds =='
DO $$
DECLARE d int; s int; l int; dec int; imp int; kpi int; sa int; cf int; v int;
BEGIN
  SELECT count(*) INTO d FROM public.muse_domains;
  SELECT count(*) INTO s FROM public.muse_systems;
  SELECT count(*) INTO l FROM public.muse_open_loops;
  SELECT count(*) INTO dec FROM public.muse_decisions;
  SELECT count(*) INTO imp FROM public.muse_improvements;
  SELECT count(*) INTO kpi FROM public.muse_kpi_registry;
  SELECT count(*) INTO sa FROM public.muse_source_authority;
  SELECT count(*) INTO cf FROM public.muse_source_conflicts;
  SELECT count(*) INTO v FROM public.muse_verifications;
  RAISE NOTICE 'seeded: % domains, % systems, % loops, % decisions, % improvements, % kpis, % sources, % conflicts, % verifications',
    d, s, l, dec, imp, kpi, sa, cf, v;
  IF d < 8 THEN RAISE EXCEPTION 'expected >= 8 domains'; END IF;
  IF s < 20 THEN RAISE EXCEPTION 'expected >= 20 systems'; END IF;
  IF l < 12 THEN RAISE EXCEPTION 'expected >= 12 open loops'; END IF;
  IF cf < 1 THEN RAISE EXCEPTION 'expected the evidenced source conflict'; END IF;
  RAISE NOTICE 'PASS: seed volumes';
END $$;

-- Idempotency: re-running the migration must not duplicate seeds.
\echo '== C. seed idempotency (re-applying migration) =='
\i supabase/migrations/20260925120000_muse_executive_layer.sql
DO $$
DECLARE d int; l int; cf int;
BEGIN
  SELECT count(*) INTO d FROM public.muse_domains;
  SELECT count(*) INTO l FROM public.muse_open_loops;
  SELECT count(*) INTO cf FROM public.muse_source_conflicts;
  IF d <> 8 THEN RAISE EXCEPTION 'domains duplicated on re-apply: %', d; END IF;
  IF l <> 13 THEN RAISE EXCEPTION 'open loops duplicated on re-apply: %', l; END IF;
  IF cf <> 1 THEN RAISE EXCEPTION 'conflicts duplicated on re-apply: %', cf; END IF;
  RAISE NOTICE 'PASS: migration is idempotent (% domains, % loops, % conflicts)', d, l, cf;
END $$;

\echo '== D. derived system health =='
SELECT system_key, status, data_status, pending_count, failing_count,
       (last_success_at IS NOT NULL) AS had_success
FROM public.muse_system_health
ORDER BY sort_order;

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.muse_system_health WHERE system_key='drive-sync';
  IF r.status <> 'HEALTHY' THEN RAISE EXCEPTION 'drive-sync expected HEALTHY, got %', r.status; END IF;
  RAISE NOTICE 'PASS: clean completed run -> HEALTHY';

  SELECT * INTO r FROM public.muse_system_health WHERE system_key='ingestion-jobs';
  IF r.status <> 'FAILING' THEN RAISE EXCEPTION 'ingestion-jobs expected FAILING, got %', r.status; END IF;
  IF r.last_failure_detail IS DISTINCT FROM 'Gemini file expired'
    THEN RAISE EXCEPTION 'expected failure detail to surface, got %', r.last_failure_detail; END IF;
  RAISE NOTICE 'PASS: newer error than success -> FAILING, with detail';

  SELECT * INTO r FROM public.muse_system_health WHERE system_key='remote-bridge';
  IF r.status <> 'STALE' THEN RAISE EXCEPTION 'remote-bridge expected STALE (cadence 30m, seen 5h ago), got %', r.status; END IF;
  RAISE NOTICE 'PASS: heartbeat beyond 2x cadence -> STALE';

  SELECT * INTO r FROM public.muse_system_health WHERE system_key='guardian-queue';
  IF r.status <> 'NEVER_RAN' THEN RAISE EXCEPTION 'guardian-queue expected NEVER_RAN, got %', r.status; END IF;
  IF r.data_status <> 'NOT_MEASURED' THEN RAISE EXCEPTION 'no telemetry must read NOT_MEASURED, got %', r.data_status; END IF;
  RAISE NOTICE 'PASS: no telemetry -> NEVER_RAN / NOT_MEASURED (never "healthy")';

  SELECT * INTO r FROM public.muse_system_health WHERE system_key='boltz-insight-engine';
  IF r.status <> 'NOT_OBSERVED' THEN RAISE EXCEPTION 'unconnected system expected NOT_OBSERVED, got %', r.status; END IF;
  IF r.data_status <> 'SOURCE_EXISTS_ACCESS_NEEDED'
    THEN RAISE EXCEPTION 'unconnected system must keep its honest status, got %', r.data_status; END IF;
  RAISE NOTICE 'PASS: unreachable system -> NOT_OBSERVED / SOURCE_EXISTS_ACCESS_NEEDED';

  SELECT * INTO r FROM public.muse_system_health WHERE system_key='approval-queue';
  IF r.pending_count <> 2 THEN RAISE EXCEPTION 'approval-queue expected 2 pending, got %', r.pending_count; END IF;
  IF NOT r.waits_on_human THEN RAISE EXCEPTION 'approval-queue must be flagged waits_on_human'; END IF;
  RAISE NOTICE 'PASS: human-waiting queue counted without being called a failure';
END $$;

\echo '== E. open loops: derived resolution and staleness =='
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.muse_open_loops_live
   WHERE derive_resolution_from = 'drive-sync';
  IF r.stored_state <> 'OPEN' THEN RAISE EXCEPTION 'fixture expects a stored OPEN state'; END IF;
  IF r.state <> 'RESOLVED' THEN
    RAISE EXCEPTION 'loop tied to a healthy system must derive RESOLVED, got % (system %)', r.state, r.derived_system_status;
  END IF;
  RAISE NOTICE 'PASS: authoritative system closed the loop (stored=% derived=%)', r.stored_state, r.state;
END $$;

DO $$
DECLARE n int;
BEGIN
  -- An old row with no fresh evidence must be marked, not silently trusted.
  UPDATE public.muse_open_loops
     SET last_evidence_at = now() - interval '200 days'
   WHERE title = 'Define The Workhouse scope, systems and primary metric';
  SELECT count(*) INTO n FROM public.muse_open_loops_live
   WHERE title = 'Define The Workhouse scope, systems and primary metric' AND evidence_stale;
  IF n <> 1 THEN RAISE EXCEPTION 'stale evidence not flagged'; END IF;
  RAISE NOTICE 'PASS: evidence older than 30 days flags evidence_stale';

  UPDATE public.muse_open_loops
     SET last_evidence_at = now()
   WHERE title = 'Define The Workhouse scope, systems and primary metric';
END $$;

\echo '== F. KPI honesty =='
SELECT metric_key, value, data_status, human_verification_required
FROM public.muse_kpi_summary ORDER BY domain_key, sort_order;

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.muse_kpi_summary WHERE metric_key='cc.marketing_spend_30d';
  IF r.value <> 375.50 THEN RAISE EXCEPTION 'expected 30d spend 375.50 (90d row excluded), got %', r.value; END IF;
  RAISE NOTICE 'PASS: windowed KPI computed from live rows (%)', r.value;

  SELECT * INTO r FROM public.muse_kpi_summary WHERE metric_key='cc.tax_returns_open';
  IF r.value <> 2 THEN RAISE EXCEPTION 'expected 2 open returns, got %', r.value; END IF;

  SELECT * INTO r FROM public.muse_kpi_summary WHERE metric_key='boltz.leads_30d';
  IF r.value IS NOT NULL THEN RAISE EXCEPTION 'unreachable KPI must have NULL value, got %', r.value; END IF;
  IF r.data_status <> 'SOURCE_EXISTS_ACCESS_NEEDED' THEN RAISE EXCEPTION 'got %', r.data_status; END IF;
  IF NOT r.human_verification_required THEN RAISE EXCEPTION 'unmeasured KPI must require verification'; END IF;
  RAISE NOTICE 'PASS: unmeasured KPI reports no number and asks for verification';

  SELECT * INTO r FROM public.muse_kpi_summary WHERE metric_key='modest.revenue_30d';
  IF r.data_status <> 'UNKNOWN' THEN RAISE EXCEPTION 'got %', r.data_status; END IF;
  RAISE NOTICE 'PASS: domain with no source of record reports UNKNOWN, not 0';
END $$;

\echo '== G. portfolio map =='
SELECT domain_key, status, data_status, open_loops, blocked_loops, decisions_pending,
       open_conflicts, unhealthy_systems, primary_kpi_name, primary_kpi_value, primary_kpi_status
FROM public.muse_portfolio_map ORDER BY sort_order;

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.muse_portfolio_map WHERE domain_key='ai_technical_systems';
  IF r.open_conflicts < 1 THEN RAISE EXCEPTION 'expected the schema conflict to surface on the domain'; END IF;
  IF r.unhealthy_systems < 1 THEN RAISE EXCEPTION 'expected the stale bridge to count as unhealthy'; END IF;
  RAISE NOTICE 'PASS: portfolio rolls up conflicts (%) and unhealthy systems (%)', r.open_conflicts, r.unhealthy_systems;

  SELECT * INTO r FROM public.muse_portfolio_map WHERE domain_key='boltz_automotive';
  IF r.primary_kpi_value IS NOT NULL THEN RAISE EXCEPTION 'unconnected domain must not show a KPI number'; END IF;
  IF r.data_status <> 'SOURCE_EXISTS_ACCESS_NEEDED' THEN RAISE EXCEPTION 'got %', r.data_status; END IF;
  RAISE NOTICE 'PASS: unconnected domain renders without inventing coverage';
END $$;

\echo '== H. executive brief =='
SELECT section, rank, left(title, 68) AS title, classification, data_status
FROM public.muse_executive_brief ORDER BY section, rank;

DO $$
DECLARE n int;
BEGIN
  -- Five sections populate from seeded truth: priorities, decisions_required,
  -- blockers, waiting, system_failures. The financial, opportunities and
  -- commitments sections are EMPTY BY DESIGN -- no business content was
  -- invented to fill them. An empty section is the honest answer until Fendi
  -- or a connected source supplies real rows.
  SELECT count(DISTINCT section) INTO n FROM public.muse_executive_brief;
  IF n < 5 THEN RAISE EXCEPTION 'expected at least 5 populated brief sections, got %', n; END IF;
  RAISE NOTICE 'PASS: % brief sections populated', n;

  SELECT count(*) INTO n FROM public.muse_executive_brief
   WHERE section IN ('financial','opportunities','commitments');
  RAISE NOTICE 'INFO: % rows in financial/opportunities/commitments (0 expected: nothing invented)', n;

  -- Prove the empty sections are wiring, not omissions: a real FINANCIAL row
  -- must reach the brief the moment one exists.
  INSERT INTO public.muse_open_loops (domain_key, title, category, priority, state, next_action)
  VALUES ('tax_credit_services', '__probe financial routing', 'FINANCIAL', 'P1', 'OPEN', 'probe');
  SELECT count(*) INTO n FROM public.muse_executive_brief
   WHERE section='financial' AND title='__probe financial routing';
  IF n <> 1 THEN RAISE EXCEPTION 'financial section is not wired'; END IF;
  DELETE FROM public.muse_open_loops WHERE title='__probe financial routing';
  RAISE NOTICE 'PASS: financial section is wired and empty only because no real row exists';

  SELECT count(*) INTO n FROM public.muse_executive_brief
   WHERE section='system_failures' AND title LIKE 'Document Ingestion Workers%';
  IF n <> 1 THEN RAISE EXCEPTION 'failing worker missing from the brief'; END IF;
  RAISE NOTICE 'PASS: a failing system reaches the brief without anyone writing a row';

  SELECT count(*) INTO n FROM public.muse_executive_brief
   WHERE section='waiting' AND classification='FENDI_DECISION' AND title LIKE 'Observation Approval Queue%';
  IF n <> 1 THEN RAISE EXCEPTION 'human-waiting queue missing from waiting section'; END IF;
  RAISE NOTICE 'PASS: queue waiting on a human appears as WAITING, not as a failure';

  -- Ordinary execution must not be routed to Fendi.
  SELECT count(*) INTO n FROM public.muse_executive_brief
   WHERE section='priorities' AND classification='AUTOMATED_SYSTEM';
  RAISE NOTICE 'INFO: % automated items in priorities (expected 0 by policy)', n;
END $$;

\echo '== I. source authority / conflicts =='
SELECT domain_key, subject, access_status, freshness, confidence, human_verification_required
FROM public.muse_source_authority_state ORDER BY domain_key, subject;

SELECT subject, system_a, system_b, candidate_authority FROM public.muse_source_conflicts_open;

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.muse_source_authority_state
   WHERE subject='Deployed / live state';
  IF r.freshness <> 'NEVER_VERIFIED' THEN RAISE EXCEPTION 'got %', r.freshness; END IF;
  IF NOT r.human_verification_required THEN RAISE EXCEPTION 'unverified source must require human verification'; END IF;
  RAISE NOTICE 'PASS: never-verified source reads NEVER_VERIFIED';

  SELECT * INTO r FROM public.muse_source_authority_state
   WHERE subject='Control Hub runtime state';
  IF r.freshness <> 'FRESH' THEN RAISE EXCEPTION 'got %', r.freshness; END IF;
  RAISE NOTICE 'PASS: freshness derived from target, not asserted';

  SELECT * INTO r FROM public.muse_source_conflicts_open LIMIT 1;
  IF r.value_a IS NULL OR r.value_b IS NULL THEN RAISE EXCEPTION 'both sides of a conflict must be preserved'; END IF;
  RAISE NOTICE 'PASS: conflict keeps both references and proposes an authority';
END $$;

\echo '== J. 1% ledger =='
SELECT domain_key, left(intervention, 50) AS intervention, verdict, status, data_status, awaiting_measurement
FROM public.muse_improvement_ledger ORDER BY created_at;

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.muse_improvement_ledger WHERE status='RUNNING' LIMIT 1;
  IF r.verdict <> 'PENDING' THEN RAISE EXCEPTION 'a running intervention cannot carry a verdict'; END IF;
  IF r.data_status <> 'NOT_MEASURED' THEN RAISE EXCEPTION 'unmeasured result must read NOT_MEASURED, got %', r.data_status; END IF;
  RAISE NOTICE 'PASS: ledger refuses a verdict before measurement';

  -- A claimed result is not a verified one.
  UPDATE public.muse_improvements SET actual_result='8 domains mapped', status='MEASURED'
   WHERE status='RUNNING';
  SELECT * INTO r FROM public.muse_improvement_ledger WHERE status='MEASURED' LIMIT 1;
  IF r.data_status <> 'NEEDS_VERIFICATION'
    THEN RAISE EXCEPTION 'a CLAIMED measurement must read NEEDS_VERIFICATION, got %', r.data_status; END IF;
  RAISE NOTICE 'PASS: agent-claimed result reads NEEDS_VERIFICATION until system/live verified';

  UPDATE public.muse_improvements SET verification_state='LIVE_VERIFIED' WHERE status='MEASURED';
  SELECT * INTO r FROM public.muse_improvement_ledger WHERE status='MEASURED' LIMIT 1;
  IF r.data_status <> 'KNOWN' THEN RAISE EXCEPTION 'live-verified result should read KNOWN, got %', r.data_status; END IF;
  RAISE NOTICE 'PASS: only live verification promotes a result to KNOWN';
END $$;

\echo '== K. SECURITY: muse_reader is read-only =='
DO $$
BEGIN
  SET LOCAL ROLE muse_reader;
  PERFORM 1 FROM public.muse_executive_brief LIMIT 1;
  PERFORM 1 FROM public.muse_portfolio_map LIMIT 1;
  PERFORM 1 FROM public.muse_system_health LIMIT 1;
  RESET ROLE;
  RAISE NOTICE 'PASS: muse_reader can SELECT the curated views';
END $$;

DO $$
BEGIN
  SET LOCAL ROLE muse_reader;
  BEGIN
    INSERT INTO public.muse_domains (key, name) VALUES ('evil','evil');
    RESET ROLE;
    RAISE EXCEPTION 'SECURITY FAIL: muse_reader inserted into muse_domains';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: muse_reader INSERT rejected -> %', SQLERRM;
  END;
END $$;

DO $$
BEGIN
  SET LOCAL ROLE muse_reader;
  BEGIN
    UPDATE public.muse_open_loops SET state='RESOLVED';
    RESET ROLE;
    RAISE EXCEPTION 'SECURITY FAIL: muse_reader updated muse_open_loops';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: muse_reader UPDATE rejected -> %', SQLERRM;
  END;
END $$;

DO $$
BEGIN
  SET LOCAL ROLE muse_reader;
  BEGIN
    DELETE FROM public.muse_decisions;
    RESET ROLE;
    RAISE EXCEPTION 'SECURITY FAIL: muse_reader deleted from muse_decisions';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: muse_reader DELETE rejected -> %', SQLERRM;
  END;
END $$;

DO $$
BEGIN
  SET LOCAL ROLE muse_reader;
  BEGIN
    PERFORM 1 FROM public.clients LIMIT 1;
    RESET ROLE;
    RAISE EXCEPTION 'SECURITY FAIL: muse_reader read a raw operational table';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: muse_reader cannot read raw base tables -> %', SQLERRM;
  END;
END $$;

DO $$
BEGIN
  SET LOCAL ROLE muse_reader;
  BEGIN
    PERFORM 1 FROM public.muse_api_tokens LIMIT 1;
    RESET ROLE;
    RAISE EXCEPTION 'SECURITY FAIL: muse_reader read token material';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: muse_reader cannot read muse_api_tokens -> %', SQLERRM;
  END;
END $$;

\echo '== L. SECURITY: anon has no Muse access =='
DO $$
BEGIN
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM 1 FROM public.muse_executive_brief LIMIT 1;
    RESET ROLE;
    RAISE EXCEPTION 'SECURITY FAIL: anon read the executive brief';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: anon cannot read muse views -> %', SQLERRM;
  END;
END $$;

DO $$
BEGIN
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM 1 FROM public.muse_domains LIMIT 1;
    RESET ROLE;
    RAISE EXCEPTION 'SECURITY FAIL: anon read muse_domains';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: anon cannot read muse tables -> %', SQLERRM;
  END;
END $$;

\echo '== M. SECURITY: operator role cannot touch token material =='
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM 1 FROM public.muse_api_tokens LIMIT 1;
    RESET ROLE;
    RAISE EXCEPTION 'SECURITY FAIL: authenticated read muse_api_tokens';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: authenticated cannot read muse_api_tokens -> %', SQLERRM;
  END;
END $$;

DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO public.muse_access_audit (resource, method, http_status)
    VALUES ('/executive/brief','GET',200);
    RESET ROLE;
    RAISE EXCEPTION 'SECURITY FAIL: authenticated wrote to the audit trail';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: authenticated cannot write the audit trail -> %', SQLERRM;
  END;
END $$;

\echo ''
\echo 'ALL MUSE SQL CHECKS PASSED'
