-- Enki's reader only calls the executive brief / decisions / improvements /
-- verifications. Those views do not include muse_work_updates, so same-day
-- ASSIGNMENT and NOTE posts (Instagram send packs, empty-queue notes) were
-- invisible even though GET /executive/work-feed already returns them.
--
-- This migration:
--   1. Puts the last 48 hours of workboard posts into muse_executive_brief
--      section `workboard` (newest is rank 1; `detail` is the exact message).
--   2. Adds muse_workboard_assignments, the ASSIGNMENT + NOTE slice, for
--      GET /executive/assignments after muse-executive is redeployed.
--
-- muse-workboard writes are unchanged. No new token scope: `read` is enough.

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

  UNION ALL
  -- Last 48 hours of the append-only board. Rank 1 is the newest post.
  -- detail is the message exactly as append_update stored it.
  SELECT 'workboard',
         lpad((20000000000 - extract(epoch FROM u.created_at))::bigint::text, 12, '0'),
         u.created_at,
         u.update_type || ' from ' || u.actor || ' · ' ||
           to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         coalesce(u.domain_key, 'unscoped'),
         coalesce(d.name, 'Unscoped'),
         u.message,
         CASE u.update_type
           WHEN 'ASSIGNMENT' THEN 'DELEGATE_TO_AGENT'
           WHEN 'NOTE' THEN 'DELEGATE_TO_AGENT'
           WHEN 'DECISION' THEN 'FENDI_DECISION'
           WHEN 'BLOCKER' THEN 'WAITING'
           ELSE 'MUSE_ANALYSIS'
         END,
         u.actor,
         NULL::timestamptz,
         'muse_work_updates',
         coalesce(u.mission_id, u.improvement_id, u.task_id)::text,
         'KNOWN',
         'CLAIMED',
         u.id::text,
         'work_update'
  FROM (
    SELECT *
    FROM public.muse_work_updates
    WHERE created_at > now() - interval '48 hours'
    ORDER BY created_at DESC
    LIMIT 40
  ) u
  LEFT JOIN public.muse_domains d ON d.key = u.domain_key
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
  'Ranked executive brief. Section workboard is the last 48 hours of muse_work_updates (newest is rank 1). detail is the exact posted message.';

CREATE OR REPLACE VIEW public.muse_workboard_assignments AS
SELECT
  u.id, u.domain_key, d.name AS domain_name, u.mission_id, u.improvement_id, u.task_id,
  u.actor, u.update_type, u.message, u.evidence_ref, u.created_at, now() AS as_of
FROM public.muse_work_updates u
LEFT JOIN public.muse_domains d ON d.key = u.domain_key
WHERE u.update_type IN ('ASSIGNMENT', 'NOTE');

COMMENT ON VIEW public.muse_workboard_assignments IS
  'ASSIGNMENT and NOTE rows from the append-only workboard. Instagram send packs and empty-queue notes live here. Full history of every update type remains muse_work_feed.';

REVOKE ALL ON public.muse_workboard_assignments FROM anon, PUBLIC;
GRANT SELECT ON public.muse_workboard_assignments TO authenticated, service_role, muse_reader;
