-- ---------------------------------------------------------------------------
-- Muse v2 (mission board + daily improvement engine) verification.
-- Every check RAISEs on failure, so a clean run means every assertion held.
-- Run via scripts/muse/verify-muse-sql.sh (after the v1 suite).
--
-- The Boltz card used here is the worked example from the build brief. It is
-- test data in a throwaway database, never seeded into the real one.
-- ---------------------------------------------------------------------------
\set ON_ERROR_STOP on
\timing off
-- Query results are noise here; every assertion reports through NOTICE.
\o /dev/null

-- expect_fail(sql, sqlstate, label): the statement must fail with that SQLSTATE.
CREATE OR REPLACE FUNCTION pg_temp.expect_fail(p_sql text, p_state text, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    IF SQLSTATE <> p_state THEN
      RAISE EXCEPTION 'FAIL: % — expected SQLSTATE %, got % (%)', p_label, p_state, SQLSTATE, SQLERRM;
    END IF;
    RAISE NOTICE 'PASS: % -> %', p_label, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL: % — statement succeeded but must be refused', p_label;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, id uuid NOT NULL);

\echo '== A. structure and legacy mapping =='
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.muse_improvements WHERE status IN ('RUNNING','MEASURED');
  IF n <> 0 THEN RAISE EXCEPTION 'legacy statuses left unmapped: %', n; END IF;
  RAISE NOTICE 'PASS: v1 RUNNING/MEASURED mapped onto the v2 lifecycle';

  SELECT count(*) INTO n FROM public.muse_systems
   WHERE (key, agent_tier) IN (('muse','EXECUTIVE'),('grok-bot','CHIEF_OF_STAFF'),
                               ('claude-code','SPECIALIST'),('cursor-workflows','SPECIALIST'));
  IF n <> 4 THEN RAISE EXCEPTION 'agent hierarchy not registered (%/4)', n; END IF;
  RAISE NOTICE 'PASS: Muse / Grok Bot / specialists registered with tiers';

  IF public.muse_actor_tier('Fendi') <> 'OWNER' THEN RAISE EXCEPTION 'Fendi must resolve to OWNER'; END IF;
  IF public.muse_actor_tier('some-random-bot') IS NOT NULL THEN RAISE EXCEPTION 'unknown actor must not get a tier'; END IF;
  RAISE NOTICE 'PASS: actor tiers resolve; unknown actors get none';
END $$;

\echo '== B. who may propose =='
SELECT pg_temp.expect_fail($q$
  INSERT INTO public.muse_improvements (domain_key, problem, intervention, metric, created_by)
  VALUES ('boltz_automotive','x','y','z','claude-code') $q$,
  '42501', 'a specialist (Claude) cannot create business priorities');
SELECT pg_temp.expect_fail($q$
  INSERT INTO public.muse_improvements (domain_key, problem, intervention, metric)
  VALUES ('boltz_automotive','x','y','z') $q$,
  '42501', 'an improvement without a declared proposer is refused');
SELECT pg_temp.expect_fail($q$
  INSERT INTO public.muse_improvements (domain_key, problem, intervention, metric, created_by, status)
  VALUES ('boltz_automotive','x','y','z','muse','SELECTED') $q$,
  '23514', 'a new improvement cannot skip PROPOSED');

\echo '== C. mission + daily improvement (the Boltz card) =='
DO $$
DECLARE mid uuid; iid uuid;
BEGIN
  INSERT INTO public.muse_missions (domain_key, title, objective, metric, created_by, status, owner, priority)
  VALUES ('boltz_automotive', 'Boltz booked-job revenue without more ad spend',
          'Increase Boltz booked-job revenue without increasing ad spend',
          'Qualified lead -> booked appointment conversion', 'Fendi', 'ACTIVE', 'Grok Bot', 'P1')
  RETURNING id INTO mid;
  INSERT INTO ids VALUES ('mission', mid);

  INSERT INTO public.muse_improvements
    (domain_key, improvement_date, is_primary, function_area, observation, problem, intervention,
     hypothesis, metric, metric_key, expected_result, owner, created_by, linked_mission_id, priority)
  VALUES ('boltz_automotive', current_date, true, 'Lead conversion',
          'Qualified Facebook leads are receiving only one follow-up',
          'Leads that do not answer the first message are never contacted again',
          'Conditional second follow-up at 24 hours when no customer response exists',
          'A second touch recovers otherwise lost opportunities',
          'Qualified lead -> appointment conversion', 'boltz.lead_to_appt',
          'Recover lost opportunities without increasing ad spend', 'grok-bot', 'muse', mid, 'P1')
  RETURNING id INTO iid;
  INSERT INTO ids VALUES ('boltz', iid);
  RAISE NOTICE 'PASS: Muse proposed the daily improvement';
END $$;

-- State moves only through the transition functions.
SELECT pg_temp.expect_fail($q$
  UPDATE public.muse_improvements SET status='SELECTED' WHERE id=(SELECT id FROM ids WHERE k='boltz') $q$,
  '42501', 'a bare UPDATE of status is refused (must use muse_transition_improvement)');
SELECT pg_temp.expect_fail($q$
  SELECT public.muse_transition_improvement((SELECT id FROM ids WHERE k='boltz'), 'SELECTED', 'claude-code') $q$,
  '42501', 'Claude cannot select an improvement');
SELECT pg_temp.expect_fail($q$
  SELECT public.muse_transition_improvement((SELECT id FROM ids WHERE k='boltz'), 'SELECTED', 'muse') $q$,
  '23514', 'selection needs risk / reversibility / confidence / executor / DoD / window');

UPDATE public.muse_improvements
   SET risk='LOW', reversibility='REVERSIBLE', confidence='MEDIUM', recommended_executor='claude-code',
       definition_of_done='["rule implemented","duplicate suppression verified","opt-out/consent rules preserved","live test succeeds"]',
       verification_requirement='LIVE_VERIFIED', measurement_window_days=7
 WHERE id=(SELECT id FROM ids WHERE k='boltz');

DO $$
DECLARE r public.muse_improvements;
BEGIN
  r := public.muse_transition_improvement((SELECT id FROM ids WHERE k='boltz'), 'SELECTED', 'muse', 'primary daily candidate');
  IF r.status <> 'SELECTED' OR r.selected_by <> 'muse' OR r.selected_at IS NULL THEN
    RAISE EXCEPTION 'selection not recorded: % % %', r.status, r.selected_by, r.selected_at;
  END IF;
  RAISE NOTICE 'PASS: Muse selected it (selected_by=%, owner_attention=%)', r.selected_by, r.owner_attention;
END $$;

\echo '== D. assignment (Grok) and execution (Claude) =='
SELECT pg_temp.expect_fail($q$
  INSERT INTO public.muse_improvement_tasks (improvement_id, title, executor, assigned_by)
  VALUES ((SELECT id FROM ids WHERE k='boltz'), 'x', 'claude-code', 'claude-code') $q$,
  '42501', 'Claude cannot assign work to itself');

DO $$
DECLARE tid uuid; st text;
BEGIN
  INSERT INTO public.muse_improvement_tasks
    (improvement_id, title, executor, assigned_by, objective, instructions, expected_artifact, due_at,
     definition_of_done)
  VALUES ((SELECT id FROM ids WHERE k='boltz'), 'Implement conditional 24h second follow-up',
          'claude-code', 'grok-bot', 'Second touch for unanswered qualified leads',
          'Add the rule in the Boltz follow-up scheduler; suppress duplicates; honour opt-out',
          'PR + live test transcript', now() + interval '2 days',
          '["rule implemented","duplicate suppression verified","opt-out preserved","live test succeeds"]')
  RETURNING id INTO tid;
  INSERT INTO ids VALUES ('task', tid);

  SELECT status INTO st FROM public.muse_improvements WHERE id=(SELECT id FROM ids WHERE k='boltz');
  IF st <> 'IN_EXECUTION' THEN RAISE EXCEPTION 'first assignment must advance the improvement, got %', st; END IF;
  RAISE NOTICE 'PASS: Grok assigned the task; improvement advanced to IN_EXECUTION automatically';
END $$;

SELECT pg_temp.expect_fail($q$
  INSERT INTO public.muse_improvement_tasks (improvement_id, title, executor, assigned_by)
  VALUES ((SELECT id FROM ids WHERE k='boltz'), '  implement conditional 24H second follow-up ', 'cursor-workflows', 'grok-bot') $q$,
  '23505', 'the same open task cannot be assigned twice (duplicate-work guard)');

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.muse_agent_queue WHERE executor='claude-code' AND is_open;
  IF n <> 1 THEN RAISE EXCEPTION 'Claude''s queue should hold exactly its 1 open task, got %', n; END IF;
  SELECT count(*) INTO n FROM public.muse_agent_queue WHERE executor='cursor-workflows' AND is_open;
  IF n <> 0 THEN RAISE EXCEPTION 'unrelated executor must see nothing, got %', n; END IF;
  RAISE NOTICE 'PASS: MY ASSIGNED TASKS is a filtered view (claude-code=1, cursor=0)';
END $$;

SELECT pg_temp.expect_fail($q$
  SELECT public.muse_transition_task((SELECT id FROM ids WHERE k='task'), 'IN_PROGRESS', 'cursor-workflows') $q$,
  '42501', 'another specialist cannot drive someone else''s task');
SELECT public.muse_transition_task((SELECT id FROM ids WHERE k='task'), 'IN_PROGRESS', 'claude-code', 'starting');
SELECT pg_temp.expect_fail($q$
  SELECT public.muse_transition_task((SELECT id FROM ids WHERE k='task'), 'BLOCKED', 'claude-code') $q$,
  '23514', 'BLOCKED requires a named blocker');
SELECT public.muse_transition_task((SELECT id FROM ids WHERE k='task'), 'BLOCKED', 'claude-code',
  p_blocker => 'Needs read access to Boltz message_jobs');

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.muse_executive_brief
   WHERE section='blockers' AND item_type='task' AND title LIKE 'Task blocked:%';
  IF n <> 1 THEN RAISE EXCEPTION 'a blocked task must reach the brief, got %', n; END IF;
  RAISE NOTICE 'PASS: blocked task surfaces in the executive brief without anyone writing prose';
END $$;

SELECT public.muse_transition_task((SELECT id FROM ids WHERE k='task'), 'IN_PROGRESS', 'grok-bot', 'access granted');
SELECT pg_temp.expect_fail($q$
  SELECT public.muse_transition_task((SELECT id FROM ids WHERE k='task'), 'IMPLEMENTED', 'claude-code') $q$,
  '23514', 'IMPLEMENTED requires a claimed_completion');
SELECT public.muse_transition_task((SELECT id FROM ids WHERE k='task'), 'IMPLEMENTED', 'claude-code',
  p_claimed_completion => 'Rule shipped in PR #1; duplicate suppression unit-tested',
  p_evidence => '["https://github.com/example/pr/1"]');

\echo '== E. "done" is not completion: verification =='
DO $$
DECLARE t record; v record;
BEGIN
  SELECT * INTO t FROM public.muse_improvement_tasks WHERE id=(SELECT id FROM ids WHERE k='task');
  IF t.state <> 'IMPLEMENTED' THEN RAISE EXCEPTION 'expected IMPLEMENTED, got %', t.state; END IF;
  IF t.verification_id IS NULL THEN RAISE EXCEPTION 'IMPLEMENTED must open a verification'; END IF;
  SELECT * INTO v FROM public.muse_verification_queue WHERE id=t.verification_id;
  IF v.queue_state <> 'PENDING' OR v.verification_state <> 'CLAIMED' OR v.required_state <> 'LIVE_VERIFIED' THEN
    RAISE EXCEPTION 'claim must sit PENDING/CLAIMED needing LIVE_VERIFIED, got % % %', v.queue_state, v.verification_state, v.required_state;
  END IF;
  INSERT INTO ids VALUES ('v1', t.verification_id);
  RAISE NOTICE 'PASS: claim entered the verification queue as CLAIMED (requires %)', v.required_state;
END $$;

SELECT pg_temp.expect_fail($q$
  SELECT public.muse_transition_task((SELECT id FROM ids WHERE k='task'), 'COMPLETE', 'claude-code') $q$,
  '23514', 'Claude cannot close its own task (IMPLEMENTED -> COMPLETE is not an edge)');
SELECT pg_temp.expect_fail($q$
  SELECT public.muse_verify((SELECT id FROM ids WHERE k='v1'), 'claude-code', 'LIVE_VERIFIED', p_live_evidence => 'trust me') $q$,
  '42501', 'the claimant cannot verify its own claim');
SELECT pg_temp.expect_fail($q$
  SELECT public.muse_verify((SELECT id FROM ids WHERE k='v1'), 'grok-bot', 'LIVE_VERIFIED') $q$,
  '23514', 'LIVE_VERIFIED needs live evidence');

-- Verification fails: the task goes back to its executor.
SELECT public.muse_verify((SELECT id FROM ids WHERE k='v1'), 'grok-bot',
  p_failure_reason => 'Live test sent the follow-up to an opted-out lead');
DO $$
DECLARE t record; v record;
BEGIN
  SELECT * INTO t FROM public.muse_improvement_tasks WHERE id=(SELECT id FROM ids WHERE k='task');
  IF t.state <> 'IN_PROGRESS' THEN RAISE EXCEPTION 'failed verification must return the task, got %', t.state; END IF;
  SELECT * INTO v FROM public.muse_verification_queue WHERE id=(SELECT id FROM ids WHERE k='v1');
  IF v.queue_state <> 'FAILED' THEN RAISE EXCEPTION 'expected FAILED in queue, got %', v.queue_state; END IF;
  RAISE NOTICE 'PASS: failed verification -> task back to IN_PROGRESS, claim shows FAILED';
END $$;
SELECT pg_temp.expect_fail($q$
  SELECT public.muse_verify((SELECT id FROM ids WHERE k='v1'), 'grok-bot', 'LIVE_VERIFIED', p_live_evidence => 'x') $q$,
  '23514', 'a failed verification cannot be revived; a new claim opens a new one');

-- Rework, re-claim, pass.
SELECT public.muse_transition_task((SELECT id FROM ids WHERE k='task'), 'IMPLEMENTED', 'claude-code',
  p_claimed_completion => 'Opt-out check added before send; live test repeated');
DO $$
DECLARE t record; st text; vs text;
BEGIN
  SELECT * INTO t FROM public.muse_improvement_tasks WHERE id=(SELECT id FROM ids WHERE k='task');
  IF t.verification_id = (SELECT id FROM ids WHERE k='v1') THEN RAISE EXCEPTION 're-claim must open a NEW verification'; END IF;
  PERFORM public.muse_verify(t.verification_id, 'grok-bot', 'ARTIFACT_VERIFIED', p_evidence_url => 'https://github.com/example/pr/2');
  SELECT state INTO st FROM public.muse_improvement_tasks WHERE id=t.id;
  IF st <> 'VERIFICATION' THEN RAISE EXCEPTION 'partial verification must hold the task in VERIFICATION, got %', st; END IF;
  RAISE NOTICE 'PASS: ARTIFACT_VERIFIED is not enough when LIVE_VERIFIED is required (task stays VERIFICATION)';

  PERFORM public.muse_verify(t.verification_id, 'grok-bot', 'LIVE_VERIFIED',
    p_live_evidence => 'Test lead received second follow-up at +24h; opted-out lead received none');
  SELECT state INTO st FROM public.muse_improvement_tasks WHERE id=t.id;
  IF st <> 'COMPLETE' THEN RAISE EXCEPTION 'requirement met by another verifier must complete the task, got %', st; END IF;
  SELECT status, verification_state INTO st, vs FROM public.muse_improvements WHERE id=(SELECT id FROM ids WHERE k='boltz');
  IF st <> 'VERIFICATION' OR vs <> 'LIVE_VERIFIED' THEN
    RAISE EXCEPTION 'last task closing must move the improvement to VERIFICATION/LIVE_VERIFIED, got %/%', st, vs;
  END IF;
  RAISE NOTICE 'PASS: LIVE_VERIFIED by Grok completed the task; improvement -> VERIFICATION (LIVE_VERIFIED)';
END $$;

SELECT pg_temp.expect_fail($q$
  UPDATE public.muse_improvement_tasks SET claimed_completion='rewritten' WHERE id=(SELECT id FROM ids WHERE k='task') $q$,
  '23514', 'a COMPLETE task is immutable');

\echo '== F. measurement discipline =='
SELECT pg_temp.expect_fail($q$
  INSERT INTO public.muse_improvement_measurements (improvement_id, checkpoint, metric_value, recorded_by)
  VALUES ((SELECT id FROM ids WHERE k='boltz'), 'IMMEDIATE', 0.21, 'muse') $q$,
  '23514', 'no post-change measurement before the change is implemented');

INSERT INTO public.muse_improvement_measurements (improvement_id, checkpoint, metric_value, recorded_by, data_status, source_ref)
VALUES ((SELECT id FROM ids WHERE k='boltz'), 'BASELINE', 0.18, 'muse', 'KNOWN', 'boltz leads 30d before change');

DO $$
DECLARE r public.muse_improvements;
BEGIN
  r := public.muse_transition_improvement((SELECT id FROM ids WHERE k='boltz'), 'MEASURING', 'grok-bot', 'deployed and live-verified');
  IF r.implemented_at IS NULL OR r.review_at IS NULL THEN RAISE EXCEPTION 'MEASURING must stamp implemented_at and review_at'; END IF;
  IF r.review_at::date <> (r.implemented_at + interval '7 days')::date THEN
    RAISE EXCEPTION 'review_at must follow the 7-day window, got %', r.review_at;
  END IF;
  RAISE NOTICE 'PASS: MEASURING stamped implemented_at and a review date 7 days out';
END $$;

SELECT pg_temp.expect_fail($q$
  INSERT INTO public.muse_improvement_measurements (improvement_id, checkpoint, metric_value, recorded_by)
  VALUES ((SELECT id FROM ids WHERE k='boltz'), 'D7', 0.22, 'muse') $q$,
  '23514', 'a 7-day result cannot be recorded on day 0');
SELECT pg_temp.expect_fail($q$
  SELECT public.muse_transition_improvement((SELECT id FROM ids WHERE k='boltz'), 'DECIDED', 'muse', p_verdict => 'KEEP') $q$,
  '23514', 'KEEP is refused with no post-change evidence');
SELECT pg_temp.expect_fail($q$
  UPDATE public.muse_improvements SET verdict='KEEP' WHERE id=(SELECT id FROM ids WHERE k='boltz') $q$,
  '23514', 'a verdict cannot be written outside a DECIDED transition');

-- Simulate the passage of the measurement window.
UPDATE public.muse_improvements SET implemented_at = now() - interval '8 days'
 WHERE id=(SELECT id FROM ids WHERE k='boltz');

INSERT INTO public.muse_improvement_measurements
  (improvement_id, checkpoint, metric_value, recorded_by, financial_impact_usd, time_saved_minutes,
   unintended_consequences, data_status, source_ref)
VALUES ((SELECT id FROM ids WHERE k='boltz'), 'D7', 0.23, 'muse', 1450, 0,
        'Two customers replied asking to stop texts', 'NEEDS_VERIFICATION', 'boltz leads d0-d7');

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.muse_impact_ledger WHERE id=(SELECT id FROM ids WHERE k='boltz');
  IF r.metric_delta IS NULL OR round(r.metric_delta, 2) <> 0.05 THEN RAISE EXCEPTION 'delta should be 0.05, got %', r.metric_delta; END IF;
  IF r.data_status <> 'NEEDS_VERIFICATION' THEN RAISE EXCEPTION 'unverified result must not read KNOWN, got %', r.data_status; END IF;
  IF r.unintended_consequences IS NULL THEN RAISE EXCEPTION 'side effects must be carried to the ledger'; END IF;
  RAISE NOTICE 'PASS: impact ledger computes delta %, carries $% and side effects, stays NEEDS_VERIFICATION', r.metric_delta, r.financial_impact_usd;
END $$;

SELECT pg_temp.expect_fail($q$
  UPDATE public.muse_improvement_measurements SET metric_value = 0.40
   WHERE improvement_id=(SELECT id FROM ids WHERE k='boltz') AND checkpoint='D7' $q$,
  '42501', 'a recorded measurement cannot be rewritten');
SELECT pg_temp.expect_fail($q$
  DELETE FROM public.muse_improvement_measurements WHERE improvement_id=(SELECT id FROM ids WHERE k='boltz') $q$,
  '42501', 'measurements cannot be deleted');
SELECT pg_temp.expect_fail($q$
  SELECT public.muse_transition_improvement((SELECT id FROM ids WHERE k='boltz'), 'DECIDED', 'muse', p_verdict => 'KEEP') $q$,
  '23514', 'KEEP needs a KNOWN (verified) post-change measurement');

UPDATE public.muse_improvement_measurements SET data_status='KNOWN', notes='Checked against Boltz appointments table'
 WHERE improvement_id=(SELECT id FROM ids WHERE k='boltz') AND checkpoint='D7';

SELECT pg_temp.expect_fail($q$
  SELECT public.muse_transition_improvement((SELECT id FROM ids WHERE k='boltz'), 'DECIDED', 'grok-bot', p_verdict => 'KEEP') $q$,
  '42501', 'Grok coordinates but does not judge: only Muse or Fendi decide the verdict');
SELECT pg_temp.expect_fail($q$
  SELECT public.muse_transition_improvement((SELECT id FROM ids WHERE k='boltz'), 'DECIDED', 'muse', p_verdict => 'REVISE') $q$,
  '23514', 'REVISE must name the next iteration');

DO $$
DECLARE r public.muse_improvements;
BEGIN
  r := public.muse_transition_improvement((SELECT id FROM ids WHERE k='boltz'), 'DECIDED', 'muse',
         'D7 conversion 18% -> 23%, verified', p_verdict => 'KEEP');
  r := public.muse_transition_improvement(r.id, 'CLOSED', 'grok-bot', 'recorded in institutional memory');
  IF r.status <> 'CLOSED' OR r.verdict <> 'KEEP' THEN RAISE EXCEPTION 'expected CLOSED/KEEP, got %/%', r.status, r.verdict; END IF;
  RAISE NOTICE 'PASS: Muse decided KEEP from verified evidence; Grok closed it';
END $$;

\echo '== G. history is preserved and append-only =='
DO $$
DECLARE n int; seq text;
BEGIN
  SELECT string_agg(to_state || '@' || actor, ' > ' ORDER BY id) INTO seq
    FROM public.muse_state_events WHERE subject_id=(SELECT id FROM ids WHERE k='task');
  RAISE NOTICE 'task history: %', seq;
  IF seq NOT LIKE 'ASSIGNED@grok-bot > IN_PROGRESS@claude-code > BLOCKED@claude-code > IN_PROGRESS@grok-bot > IMPLEMENTED@claude-code > IN_PROGRESS@grok-bot > IMPLEMENTED@claude-code > VERIFICATION@grok-bot > COMPLETE@grok-bot' THEN
    RAISE EXCEPTION 'task history is not the expected chain';
  END IF;
  SELECT string_agg(to_state || '@' || actor, ' > ' ORDER BY id) INTO seq
    FROM public.muse_state_events WHERE subject_id=(SELECT id FROM ids WHERE k='boltz');
  RAISE NOTICE 'improvement history: %', seq;
  IF seq <> 'PROPOSED@muse > SELECTED@muse > IN_EXECUTION@system:auto > VERIFICATION@system:auto > MEASURING@grok-bot > DECIDED@muse > CLOSED@grok-bot' THEN
    RAISE EXCEPTION 'improvement history is not the expected chain';
  END IF;
  SELECT count(*) INTO n FROM public.muse_state_events
   WHERE subject_id=(SELECT id FROM ids WHERE k='v1') AND to_state='FAILED';
  IF n <> 1 THEN RAISE EXCEPTION 'verification failure must be in history'; END IF;
  RAISE NOTICE 'PASS: every state change recorded with its actor, including the failed verification';
END $$;

\echo '== H. collision protection -> OBSERVE =='
DO $$
DECLARE a uuid; b uuid; o uuid; r record;
BEGIN
  INSERT INTO public.muse_improvements
    (domain_key, problem, intervention, metric, metric_key, created_by, risk, reversibility, confidence,
     recommended_executor, definition_of_done, measurement_window_days, function_area)
  VALUES ('tax_credit_services', 'Returns wait on intake', 'Auto-request missing W-2s', 'Open tax returns',
          'cc.tax_returns_open', 'muse', 'LOW', 'REVERSIBLE', 'MEDIUM', 'claude-code', '["x"]', 14, 'Intake')
  RETURNING id INTO a;
  PERFORM public.muse_transition_improvement(a, 'SELECTED', 'muse');

  INSERT INTO public.muse_improvements
    (domain_key, problem, intervention, metric, metric_key, created_by, risk, reversibility, confidence,
     recommended_executor, definition_of_done, measurement_window_days, function_area)
  VALUES ('tax_credit_services', 'Returns wait on review', 'Daily review reminder', 'open tax returns',
          'CC.TAX_RETURNS_OPEN ', 'muse', 'LOW', 'REVERSIBLE', 'LOW', 'claude-code', '["y"]', 14, 'Intake')
  RETURNING id INTO b;
  INSERT INTO ids VALUES ('collide', b);

  SELECT * INTO r FROM public.muse_improvement_ledger WHERE id=b;
  IF r.collision_count <> 1 THEN RAISE EXCEPTION 'ledger must show the live experiment on the same metric, got %', r.collision_count; END IF;
  IF r.metric_data_status <> 'KNOWN' THEN RAISE EXCEPTION 'metric data status must come from the KPI registry, got %', r.metric_data_status; END IF;
  RAISE NOTICE 'PASS: collision visible before selection (% | %)', r.collision_count, r.collision_with;

  -- Muse chooses OBSERVE instead of contaminating the measurement.
  INSERT INTO public.muse_improvements
    (domain_key, kind, improvement_date, is_primary, problem, intervention, metric, created_by,
     observation, linked_experiment_id)
  VALUES ('tax_credit_services', 'OBSERVE', current_date + 1, true, 'Experiment still measuring',
          'OBSERVE — NO CHANGE YET', 'Open tax returns', 'muse',
          'W-2 auto-request experiment has not reached its review date', a)
  RETURNING id INTO o;
  PERFORM public.muse_transition_improvement(o, 'SELECTED', 'muse');
  PERFORM public.muse_transition_improvement(o, 'CLOSED', 'muse', 'observed; no change made');
  RAISE NOTICE 'PASS: OBSERVE outcome recorded and closed without any intervention';
END $$;

SELECT pg_temp.expect_fail($q$
  SELECT public.muse_transition_improvement((SELECT id FROM ids WHERE k='collide'), 'SELECTED', 'muse') $q$,
  '23505', 'a second experiment on the same metric is refused');
SELECT pg_temp.expect_fail($q$
  INSERT INTO public.muse_improvement_tasks (improvement_id, title, executor, assigned_by)
  VALUES ((SELECT id FROM ids WHERE k='collide'), 'x', 'claude-code', 'grok-bot') $q$,
  '23514', 'work cannot be assigned on an unselected improvement');
SELECT pg_temp.expect_fail($q$
  INSERT INTO public.muse_improvements (domain_key, improvement_date, is_primary, problem, intervention, metric, created_by)
  VALUES ('the_workhouse', current_date, true, 'x', 'y', 'z', 'muse') $q$,
  '23505', 'only one primary daily outcome per date');

\echo '== I. owner attention budget =='
SELECT pg_temp.expect_fail($q$
  INSERT INTO public.muse_improvements (domain_key, problem, intervention, metric, created_by, risk, owner_attention)
  VALUES ('boltz_automotive','x','Change lead routing','m','muse','HIGH','NONE') $q$,
  '23514', 'high-risk work cannot be filed with owner_attention NONE');
SELECT pg_temp.expect_fail($q$
  INSERT INTO public.muse_improvements (domain_key, problem, intervention, metric, created_by, reversibility, owner_attention)
  VALUES ('boltz_automotive','x','Delete old leads','m','muse','IRREVERSIBLE','INFORM') $q$,
  '23514', 'irreversible work cannot be filed as INFORM');

DO $$
DECLARE h uuid; n int;
BEGIN
  INSERT INTO public.muse_improvements
    (domain_key, problem, intervention, metric, created_by, risk, reversibility, confidence,
     recommended_executor, definition_of_done, measurement_window_days, owner_attention)
  VALUES ('boltz_automotive', 'Pricing page converts poorly', 'Change published labour rates',
          'Quote acceptance rate', 'muse', 'HIGH', 'REVERSIBLE', 'LOW', 'claude-code', '["x"]', 30, 'APPROVAL')
  RETURNING id INTO h;
  INSERT INTO ids VALUES ('highrisk', h);

  SELECT count(*) INTO n FROM public.muse_executive_brief
   WHERE section='decisions_required' AND item_id=h::text;
  IF n <> 0 THEN RAISE EXCEPTION 'an unselected proposal must not spend Fendi''s attention'; END IF;

  PERFORM public.muse_transition_improvement(h, 'SELECTED', 'muse');
  SELECT count(*) INTO n FROM public.muse_executive_brief
   WHERE section='decisions_required' AND item_id=h::text AND classification='FENDI_DECISION';
  IF n <> 1 THEN RAISE EXCEPTION 'a selected high-risk improvement must reach Fendi as a decision'; END IF;
  RAISE NOTICE 'PASS: Fendi sees it only after Muse selects it, as a decision';
END $$;

SELECT pg_temp.expect_fail($q$
  INSERT INTO public.muse_improvement_tasks (improvement_id, title, executor, assigned_by)
  VALUES ((SELECT id FROM ids WHERE k='highrisk'), 'Update rates', 'claude-code', 'grok-bot') $q$,
  '42501', 'no execution before Fendi approves');
SELECT pg_temp.expect_fail($q$
  UPDATE public.muse_improvements SET approved_by='grok-bot', approved_at=now() WHERE id=(SELECT id FROM ids WHERE k='highrisk');
  INSERT INTO public.muse_improvement_tasks (improvement_id, title, executor, assigned_by)
  VALUES ((SELECT id FROM ids WHERE k='highrisk'), 'Update rates', 'claude-code', 'grok-bot') $q$,
  '42501', 'approval must come from Fendi, not an agent');

DO $$
DECLARE n int;
BEGIN
  UPDATE public.muse_improvements SET approved_by='Fendi', approved_at=now() WHERE id=(SELECT id FROM ids WHERE k='highrisk');
  INSERT INTO public.muse_improvement_tasks (improvement_id, title, executor, assigned_by)
  VALUES ((SELECT id FROM ids WHERE k='highrisk'), 'Update rates', 'claude-code', 'grok-bot');
  SELECT count(*) INTO n FROM public.muse_executive_brief
   WHERE section='decisions_required' AND item_id=(SELECT id FROM ids WHERE k='highrisk')::text;
  IF n <> 0 THEN RAISE EXCEPTION 'an approved improvement must leave Fendi''s decision list'; END IF;
  RAISE NOTICE 'PASS: after Fendi approves, work can be assigned and the decision clears from the brief';
END $$;

SELECT pg_temp.expect_fail($q$
  SELECT public.muse_transition_task(
    (SELECT id FROM public.muse_improvement_tasks WHERE title='Update rates'), 'CANCELLED', 'claude-code',
    p_cancelled_reason => 'do not want to') $q$,
  '42501', 'an executor cannot cancel its own assignment');

\echo '== J. mission board and portfolio rotation =='
DO $$
DECLARE r record; n int;
BEGIN
  SELECT * INTO r FROM public.muse_mission_board WHERE id=(SELECT id FROM ids WHERE k='mission');
  IF r.improvements_total <> 1 OR r.improvements_kept <> 1 THEN
    RAISE EXCEPTION 'mission must roll up its linked improvement (total %, kept %)', r.improvements_total, r.improvements_kept;
  END IF;
  IF r.data_status <> 'NOT_MEASURED' THEN RAISE EXCEPTION 'mission without baseline must read NOT_MEASURED, got %', r.data_status; END IF;
  RAISE NOTICE 'PASS: mission board rolls up improvements and is honest about its unmeasured baseline';

  SELECT count(*) INTO n FROM public.muse_portfolio_map WHERE attention_flag = 'UNDER_ATTENDED';
  IF n <> 0 THEN RAISE EXCEPTION 'no domain may be flagged under-attended before 30 days of board history'; END IF;
  RAISE NOTICE 'PASS: rotation flags wait for 30 days of history instead of inventing neglect';
END $$;

SELECT pg_temp.expect_fail($q$
  SELECT public.muse_transition_mission((SELECT id FROM ids WHERE k='mission'), 'ACHIEVED', 'grok-bot') $q$,
  '42501', 'only Fendi or Muse move a mission');

\echo '== K. SECURITY =='
DO $$
BEGIN
  SET LOCAL ROLE muse_reader;
  PERFORM 1 FROM public.muse_mission_board LIMIT 1;
  PERFORM 1 FROM public.muse_agent_queue LIMIT 1;
  PERFORM 1 FROM public.muse_verification_queue LIMIT 1;
  PERFORM 1 FROM public.muse_impact_ledger LIMIT 1;
  PERFORM 1 FROM public.muse_improvement_ledger LIMIT 1;
  RESET ROLE;
  RAISE NOTICE 'PASS: muse_reader can read every new view';
END $$;

SELECT pg_temp.expect_fail($q$
  SET LOCAL ROLE muse_reader;
  SELECT public.muse_transition_improvement((SELECT id FROM public.muse_improvement_ledger LIMIT 1), 'REJECTED', 'muse') $q$,
  '42501', 'muse_reader cannot call the write protocol');
SELECT pg_temp.expect_fail($q$
  SET LOCAL ROLE muse_reader;
  INSERT INTO public.muse_improvement_tasks (improvement_id, title, executor, assigned_by)
  VALUES (gen_random_uuid(), 'x', 'claude-code', 'grok-bot') $q$,
  '42501', 'muse_reader cannot write tasks');
SELECT pg_temp.expect_fail($q$
  SET LOCAL ROLE anon;
  SELECT 1 FROM public.muse_agent_queue $q$,
  '42501', 'anon cannot read the agent queue');
SELECT pg_temp.expect_fail($q$
  SET LOCAL ROLE anon;
  SELECT public.muse_verify(gen_random_uuid(), 'Fendi') $q$,
  '42501', 'anon cannot call muse_verify');
SELECT pg_temp.expect_fail($q$
  SET LOCAL ROLE authenticated;
  INSERT INTO public.muse_state_events (subject_type, subject_id, to_state, actor)
  VALUES ('task', gen_random_uuid(), 'COMPLETE', 'Fendi') $q$,
  '42501', 'the operator cannot forge history');
SELECT pg_temp.expect_fail($q$
  SET LOCAL ROLE authenticated;
  DELETE FROM public.muse_state_events $q$,
  '42501', 'the operator cannot erase history');

-- The signed-in operator path works end to end under RLS.
DO $$
DECLARE iid uuid := (SELECT id FROM ids WHERE k='collide'); st text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
  SET LOCAL ROLE authenticated;
  PERFORM public.muse_transition_improvement(iid, 'REJECTED', 'Fendi', 'collides with the W-2 experiment');
  SELECT status INTO st FROM public.muse_improvements WHERE id = iid;
  RESET ROLE;
  IF st <> 'REJECTED' THEN RAISE EXCEPTION 'operator transition failed under RLS, got %', st; END IF;
  RAISE NOTICE 'PASS: signed-in operator can drive the protocol under RLS (history written by definer trigger)';
END $$;

\echo ''
\echo 'ALL MUSE v2 (MISSION BOARD) SQL CHECKS PASSED'
