-- Correct aggregate counts in the workboard views.
-- Tasks and measurements are one-to-many children of improvements; joining both
-- in one aggregate would multiply rows and inflate counts.

CREATE OR REPLACE VIEW public.muse_mission_board AS
SELECT
  m.id, m.domain_key, d.name AS domain_name, m.title, m.objective, m.business_outcome,
  m.owner, m.executive_sponsor, m.priority, m.status, m.metric, m.baseline, m.target,
  m.started_at, m.review_at, m.dependencies, m.source_ref, m.created_by, m.notes,
  m.created_at, m.updated_at,
  count(DISTINCT i.id) FILTER (WHERE i.status IN ('PROPOSED','RUNNING','MEASURED')) AS active_improvements,
  count(DISTINCT t.id) FILTER (WHERE t.state IN ('ASSIGNED','IN_PROGRESS','WAITING','BLOCKED','IMPLEMENTED','VERIFICATION')) AS active_tasks,
  count(DISTINCT t.id) FILTER (WHERE t.state = 'BLOCKED') AS blocked_tasks,
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
  (SELECT count(*) FROM public.muse_improvement_tasks t WHERE t.improvement_id = i.id) AS task_count,
  (SELECT count(*) FROM public.muse_improvement_tasks t WHERE t.improvement_id = i.id AND t.state = 'COMPLETE') AS tasks_complete,
  (SELECT count(*) FROM public.muse_improvement_tasks t WHERE t.improvement_id = i.id AND t.state = 'BLOCKED') AS tasks_blocked,
  (SELECT count(*) FROM public.muse_improvement_measurements mm WHERE mm.improvement_id = i.id) AS measurement_count,
  (i.review_at IS NOT NULL AND i.review_at <= now() AND i.status <> 'CLOSED') AS review_due,
  now() AS as_of
FROM public.muse_improvements i
JOIN public.muse_domains d ON d.key = i.domain_key
LEFT JOIN public.muse_missions m ON m.id = i.mission_id;

COMMENT ON VIEW public.muse_mission_board IS
  'Mission objectives with distinct active-improvement/task counts; no child-row multiplication.';
COMMENT ON VIEW public.muse_daily_improvement_board IS
  'Daily 1% candidates with independently counted tasks and measurements; observe-only is valid.';
