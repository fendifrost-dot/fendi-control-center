-- Muse workboard alerts.
--
-- Additive. Existing muse-workboard writes keep working when they do not
-- address anyone: the new columns are nullable and the writer omits them
-- unless the caller set them.
--
-- Push does not go through a database trigger, pg_net, or email. The edge
-- function that accepted the post enqueues a row and tries the webhook once.
-- muse-alerts retries. Agents that have no webhook URL read
-- GET muse-alerts?since= instead.

ALTER TABLE public.muse_work_updates
  ADD COLUMN IF NOT EXISTS addressed_agent text,
  ADD COLUMN IF NOT EXISTS addressed_role text;

ALTER TABLE public.muse_work_updates
  DROP CONSTRAINT IF EXISTS muse_work_updates_addressed_agent_check;
ALTER TABLE public.muse_work_updates
  ADD CONSTRAINT muse_work_updates_addressed_agent_check
  CHECK (addressed_agent IS NULL OR addressed_agent ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$');

ALTER TABLE public.muse_work_updates
  DROP CONSTRAINT IF EXISTS muse_work_updates_addressed_role_check;
ALTER TABLE public.muse_work_updates
  ADD CONSTRAINT muse_work_updates_addressed_role_check
  CHECK (addressed_role IS NULL OR addressed_role IN ('audit', 'coding', 'testing', 'execution'));

ALTER TABLE public.muse_daily_reports
  ADD COLUMN IF NOT EXISTS addressed_agent text,
  ADD COLUMN IF NOT EXISTS addressed_role text;

ALTER TABLE public.muse_daily_reports
  DROP CONSTRAINT IF EXISTS muse_daily_reports_addressed_agent_check;
ALTER TABLE public.muse_daily_reports
  ADD CONSTRAINT muse_daily_reports_addressed_agent_check
  CHECK (addressed_agent IS NULL OR addressed_agent ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$');

ALTER TABLE public.muse_daily_reports
  DROP CONSTRAINT IF EXISTS muse_daily_reports_addressed_role_check;
ALTER TABLE public.muse_daily_reports
  ADD CONSTRAINT muse_daily_reports_addressed_role_check
  CHECK (addressed_role IS NULL OR addressed_role IN ('audit', 'coding', 'testing', 'execution'));

ALTER TABLE public.muse_improvement_tasks
  ADD COLUMN IF NOT EXISTS addressed_role text;

ALTER TABLE public.muse_improvement_tasks
  DROP CONSTRAINT IF EXISTS muse_improvement_tasks_addressed_role_check;
ALTER TABLE public.muse_improvement_tasks
  ADD CONSTRAINT muse_improvement_tasks_addressed_role_check
  CHECK (addressed_role IS NULL OR addressed_role IN ('audit', 'coding', 'testing', 'execution'));

COMMENT ON COLUMN public.muse_work_updates.addressed_agent IS
  'Agent key or registered alias this post is for. Null means the post wakes nobody.';
COMMENT ON COLUMN public.muse_work_updates.addressed_role IS
  'Role this post is for: audit, coding, testing, or execution.';
COMMENT ON COLUMN public.muse_daily_reports.addressed_agent IS
  'Optional agent key or alias. A report with neither address wakes nobody.';
COMMENT ON COLUMN public.muse_daily_reports.addressed_role IS
  'Optional role. A report with neither address wakes nobody.';
COMMENT ON COLUMN public.muse_improvement_tasks.addressed_role IS
  'Optional role woken in addition to the task executor.';

-- Append-only views gain the address columns at the end. Existing columns stay put.
CREATE OR REPLACE VIEW public.muse_work_feed AS
SELECT
  u.id, u.domain_key, d.name AS domain_name, u.mission_id, u.improvement_id, u.task_id,
  u.actor, u.update_type, u.message, u.evidence_ref, u.created_at, now() AS as_of,
  u.addressed_agent, u.addressed_role
FROM public.muse_work_updates u
LEFT JOIN public.muse_domains d ON d.key = u.domain_key;

CREATE OR REPLACE VIEW public.muse_workboard_assignments AS
SELECT
  u.id, u.domain_key, d.name AS domain_name, u.mission_id, u.improvement_id, u.task_id,
  u.actor, u.update_type, u.message, u.evidence_ref, u.created_at, now() AS as_of,
  u.addressed_agent, u.addressed_role
FROM public.muse_work_updates u
LEFT JOIN public.muse_domains d ON d.key = u.domain_key
WHERE u.update_type IN ('ASSIGNMENT', 'NOTE');

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
  now() AS as_of,
  r.addressed_agent,
  r.addressed_role
FROM public.muse_daily_reports r;

CREATE OR REPLACE VIEW public.muse_agent_queue AS
SELECT
  t.id, t.improvement_id, t.domain_key, d.name AS domain_name,
  i.intervention AS improvement, t.title, t.executor, t.assigning_agent,
  t.objective, t.instructions, t.expected_artifact, t.definition_of_done,
  t.priority, t.state, t.blocker, t.due_at, t.claimed_completed_at,
  t.verification_state, t.evidence, t.source_ref, t.created_at, t.updated_at,
  (t.due_at IS NOT NULL AND t.due_at < now() AND t.state NOT IN ('COMPLETE','CANCELLED')) AS overdue,
  now() AS as_of,
  t.addressed_role
FROM public.muse_improvement_tasks t
JOIN public.muse_improvements i ON i.id = t.improvement_id
JOIN public.muse_domains d ON d.key = t.domain_key;

CREATE INDEX IF NOT EXISTS muse_work_updates_alert_idx
  ON public.muse_work_updates (created_at, id)
  WHERE addressed_agent IS NOT NULL OR addressed_role IS NOT NULL;

CREATE INDEX IF NOT EXISTS muse_daily_reports_alert_idx
  ON public.muse_daily_reports (created_at, id)
  WHERE addressed_agent IS NOT NULL OR addressed_role IS NOT NULL;

CREATE INDEX IF NOT EXISTS muse_improvement_tasks_alert_idx
  ON public.muse_improvement_tasks (created_at, id);

-- ---------------------------------------------------------------------------
-- Subscriber registry. Webhook URL and bearer are sealed (AES-GCM) with
-- MUSE_ALERT_SEAL_KEY. Email is not a delivery method.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.muse_alert_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key text NOT NULL UNIQUE
    CONSTRAINT muse_alert_subscribers_agent_key_check CHECK (agent_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  roles text[] NOT NULL DEFAULT '{}',
  aliases text[] NOT NULL DEFAULT '{}',
  delivery text NOT NULL
    CONSTRAINT muse_alert_subscribers_delivery_check CHECK (delivery IN ('webhook', 'pull')),
  enabled boolean NOT NULL DEFAULT true,
  webhook_url_sealed text,
  webhook_key_sealed text,
  webhook_host text,
  webhook_key_hint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT muse_alert_subscribers_roles_check CHECK (
    roles <@ ARRAY['audit', 'coding', 'testing', 'execution']::text[]
  ),
  CONSTRAINT muse_alert_subscribers_webhook_shape CHECK (
    (
      delivery = 'pull'
      AND webhook_url_sealed IS NULL
      AND webhook_key_sealed IS NULL
      AND webhook_host IS NULL
      AND webhook_key_hint IS NULL
    )
    OR (
      delivery = 'webhook'
      AND webhook_url_sealed IS NOT NULL
      AND webhook_key_sealed IS NOT NULL
      AND webhook_host IS NOT NULL
      AND webhook_key_hint IS NOT NULL
    )
  )
);

DROP TRIGGER IF EXISTS muse_alert_subscribers_touch ON public.muse_alert_subscribers;
CREATE TRIGGER muse_alert_subscribers_touch
  BEFORE UPDATE ON public.muse_alert_subscribers
  FOR EACH ROW EXECUTE FUNCTION public.muse_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.muse_alert_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  subscriber_id uuid NOT NULL REFERENCES public.muse_alert_subscribers(id),
  agent_key text NOT NULL,
  source_table text NOT NULL
    CONSTRAINT muse_alert_outbox_source_check CHECK (source_table IN (
      'muse_work_updates', 'muse_improvement_tasks', 'muse_daily_reports'
    )),
  source_id uuid NOT NULL,
  actor text NOT NULL,
  addressed_agent text,
  addressed_role text,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CONSTRAINT muse_alert_outbox_status_check CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0
    CONSTRAINT muse_alert_outbox_attempts_check CHECK (attempts >= 0 AND attempts <= 10),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  last_http_status integer
    CONSTRAINT muse_alert_outbox_http_check CHECK (last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599),
  last_error text
    CONSTRAINT muse_alert_outbox_error_check CHECK (last_error IS NULL OR last_error ~ '^[a-z0-9_]{1,40}$'),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS muse_alert_outbox_due_idx
  ON public.muse_alert_outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS public.muse_alert_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES public.muse_alert_outbox(id),
  attempt integer NOT NULL
    CONSTRAINT muse_alert_deliveries_attempt_check CHECK (attempt >= 1 AND attempt <= 10),
  http_status integer
    CONSTRAINT muse_alert_deliveries_http_check CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  error_code text
    CONSTRAINT muse_alert_deliveries_error_check CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,40}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS muse_alert_deliveries_outbox_idx
  ON public.muse_alert_deliveries (outbox_id, attempt);

CREATE TABLE IF NOT EXISTS public.muse_alert_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_label text NOT NULL,
  request_key text NOT NULL,
  action text NOT NULL
    CONSTRAINT muse_alert_requests_action_check CHECK (action IN (
      'register_subscriber', 'update_subscriber', 'disable_subscriber', 'dispatch'
    )),
  payload_sha256 text NOT NULL,
  http_status integer NOT NULL,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT muse_alert_requests_key_unique UNIQUE (token_label, request_key)
);

CREATE INDEX IF NOT EXISTS muse_alert_requests_created_idx
  ON public.muse_alert_requests (created_at DESC);

ALTER TABLE public.muse_alert_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_alert_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_alert_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muse_alert_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON public.muse_alert_subscribers;
CREATE POLICY "Service role full access" ON public.muse_alert_subscribers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access" ON public.muse_alert_outbox;
CREATE POLICY "Service role full access" ON public.muse_alert_outbox
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access" ON public.muse_alert_deliveries;
CREATE POLICY "Service role full access" ON public.muse_alert_deliveries
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access" ON public.muse_alert_requests;
CREATE POLICY "Service role full access" ON public.muse_alert_requests
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.muse_alert_subscribers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.muse_alert_outbox FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.muse_alert_deliveries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.muse_alert_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.muse_alert_subscribers TO service_role;
GRANT ALL ON public.muse_alert_outbox TO service_role;
GRANT ALL ON public.muse_alert_deliveries TO service_role;
GRANT ALL ON public.muse_alert_requests TO service_role;

COMMENT ON TABLE public.muse_alert_subscribers IS
  'Who hears workboard posts. delivery is webhook (sealed URL and bearer) or pull. Email is intentionally absent.';
COMMENT ON TABLE public.muse_alert_outbox IS
  'Push queue and delivery log for webhook subscribers. One row per post per subscriber. Pull subscribers are not queued.';
COMMENT ON TABLE public.muse_alert_deliveries IS
  'One row per webhook attempt. error_code is a short token. The URL, bearer, and response body are not stored.';
COMMENT ON TABLE public.muse_alert_requests IS
  'Idempotency for muse-alerts writes. payload_sha256 covers the request. The webhook URL and key are not stored.';

-- Posts an agent can be addressed on. Tasks are included because executor is the address.
CREATE OR REPLACE VIEW public.muse_alert_events AS
SELECT
  u.id AS source_id,
  'muse_work_updates'::text AS source_table,
  u.created_at,
  u.actor,
  u.addressed_agent,
  u.addressed_role,
  u.update_type AS kind,
  u.message,
  u.mission_id,
  u.improvement_id,
  u.task_id,
  u.domain_key,
  u.evidence_ref
FROM public.muse_work_updates u
WHERE u.addressed_agent IS NOT NULL OR u.addressed_role IS NOT NULL
UNION ALL
SELECT
  t.id AS source_id,
  'muse_improvement_tasks'::text AS source_table,
  t.created_at,
  t.assigning_agent AS actor,
  t.executor AS addressed_agent,
  t.addressed_role,
  'TASK'::text AS kind,
  left(concat_ws(E'\n\n', t.title, t.objective, t.instructions), 8000) AS message,
  NULL::uuid AS mission_id,
  t.improvement_id,
  t.id AS task_id,
  t.domain_key,
  t.source_ref AS evidence_ref
FROM public.muse_improvement_tasks t
UNION ALL
SELECT
  r.id AS source_id,
  'muse_daily_reports'::text AS source_table,
  r.created_at,
  r.actor,
  r.addressed_agent,
  r.addressed_role,
  r.cadence AS kind,
  r.message,
  NULL::uuid AS mission_id,
  NULL::uuid AS improvement_id,
  NULL::uuid AS task_id,
  NULL::text AS domain_key,
  r.evidence_ref
FROM public.muse_daily_reports r
WHERE r.addressed_agent IS NOT NULL OR r.addressed_role IS NOT NULL;

ALTER VIEW public.muse_alert_events SET (security_invoker = true);

REVOKE ALL ON public.muse_alert_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.muse_alert_events TO service_role;

COMMENT ON VIEW public.muse_alert_events IS
  'Addressed board posts, task assignments, and addressed daily reports. The actor is excluded by muse-alerts, not by this view.';

-- Claim due webhook rows. p_ids limits the claim to rows just inserted by the
-- writer. A null p_ids is the retry sweep: it also returns stale sends to the queue.
CREATE OR REPLACE FUNCTION public.muse_alert_claim(p_limit integer, p_ids uuid[] DEFAULT NULL)
RETURNS SETOF public.muse_alert_outbox
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  lim integer := least(greatest(coalesce(p_limit, 1), 1), 20);
BEGIN
  IF p_ids IS NULL THEN
    UPDATE public.muse_alert_outbox
    SET status = 'failed',
        last_error = 'claim_expired',
        claimed_at = NULL
    WHERE status = 'sending'
      AND claimed_at < now() - interval '2 minutes'
      AND attempts >= 5;

    UPDATE public.muse_alert_outbox
    SET status = 'pending',
        claimed_at = NULL
    WHERE status = 'sending'
      AND claimed_at < now() - interval '2 minutes'
      AND attempts < 5;
  END IF;

  RETURN QUERY
  UPDATE public.muse_alert_outbox AS o
  SET status = 'sending',
      claimed_at = now(),
      attempts = o.attempts + 1
  WHERE o.id IN (
    SELECT q.id
    FROM public.muse_alert_outbox AS q
    WHERE q.status = 'pending'
      AND q.next_attempt_at <= now()
      AND q.attempts < 5
      AND (p_ids IS NULL OR q.id = ANY (p_ids))
    ORDER BY q.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT lim
  )
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.muse_alert_claim(integer, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.muse_alert_claim(integer, uuid[]) TO service_role;

COMMENT ON FUNCTION public.muse_alert_claim(integer, uuid[]) IS
  'Locks due muse_alert_outbox rows for one dispatcher. Does not call the network.';
