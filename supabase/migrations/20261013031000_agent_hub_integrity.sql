-- ============================================================================
-- AGENT HUB INTEGRITY (review findings 2 and 3, 13 Oct 2026)
-- 2. Reserved message kinds are enforced by the database, not only the API.
-- 3. An answer and its handoff are written in one transaction, with an
--    idempotent retry and a one-answer-per-handoff index.
-- Existing rows already satisfy every rule below (checked before applying).
-- ============================================================================

-- 2. Who may write which kind.
ALTER TABLE public.agent_hub_messages DROP CONSTRAINT IF EXISTS agent_hub_messages_reserved_kinds;
ALTER TABLE public.agent_hub_messages ADD CONSTRAINT agent_hub_messages_reserved_kinds CHECK (
      (kind = 'SYSTEM') = (author_kind = 'system')                                  -- SYSTEM only from the hub
  AND (kind NOT IN ('DECISION', 'IMPORT') OR (author = 'fendi' AND author_kind = 'human'))
  AND (author_kind <> 'human' OR author = 'fendi')                                  -- "human" means Fendi
);

-- 3a. One stored answer per handoff (hub status lines are author_kind = 'system').
CREATE UNIQUE INDEX IF NOT EXISTS agent_hub_messages_one_answer_per_handoff
  ON public.agent_hub_messages (handoff_id)
  WHERE handoff_id IS NOT NULL AND author_kind <> 'system';

-- 3b. Record an answer atomically. Returns {"outcome": "recorded"|"duplicate", "message": {...}}.
--     A retry of the same answer after an interrupted call returns "duplicate" with the
--     stored message instead of failing, so callers can always retry safely.
CREATE OR REPLACE FUNCTION public.agent_hub_record_response(
  p_handoff_id  uuid,
  p_kind        text,
  p_body        text,
  p_context     jsonb DEFAULT '{}'::jsonb,
  p_attachments jsonb DEFAULT '[]'::jsonb,
  p_delivery    jsonb DEFAULT '{}'::jsonb,
  p_session_id  text  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  h  public.agent_hub_handoffs%ROWTYPE;
  m  public.agent_hub_messages%ROWTYPE;
  ts timestamptz := now();
BEGIN
  SELECT * INTO h FROM public.agent_hub_handoffs WHERE id = p_handoff_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'handoff not found' USING ERRCODE = 'P0002';
  END IF;

  IF h.status = 'RESPONDED' THEN
    SELECT * INTO m FROM public.agent_hub_messages WHERE id = h.response_message_id;
    IF FOUND AND m.body = p_body AND m.kind = p_kind THEN
      RETURN jsonb_build_object('outcome', 'duplicate', 'message', to_jsonb(m));
    END IF;
    RAISE EXCEPTION 'handoff already answered' USING ERRCODE = '23505';
  END IF;
  IF h.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'handoff was cancelled' USING ERRCODE = '22023';
  END IF;
  -- QUEUED, DELIVERED, IN_PROGRESS and FAILED (a late answer after a timeout) are all accepted.

  INSERT INTO public.agent_hub_messages
    (thread_id, author, author_kind, kind, body, reply_to, handoff_id, context, attachments)
  VALUES
    (h.thread_id, h.to_agent, 'agent', p_kind, p_body, h.source_message_id, h.id,
     coalesce(p_context, '{}'::jsonb), coalesce(p_attachments, '[]'::jsonb))
  RETURNING * INTO m;

  UPDATE public.agent_hub_handoffs
     SET status = 'RESPONDED', response_message_id = m.id, responded_at = ts, error = NULL,
         delivery = delivery || coalesce(p_delivery, '{}'::jsonb)
   WHERE id = h.id;

  UPDATE public.agent_hub_threads t
     SET last_activity_at = m.created_at,
         status = CASE
           WHEN t.status IN ('DONE', 'ARCHIVED') THEN t.status
           WHEN EXISTS (SELECT 1 FROM public.agent_hub_handoffs x
                         WHERE x.thread_id = h.thread_id AND x.id <> h.id
                           AND x.status IN ('QUEUED', 'DELIVERED', 'IN_PROGRESS')) THEN 'WAITING_ON_AGENT'
           ELSE 'WAITING_ON_FENDI' END
   WHERE t.id = h.thread_id;

  UPDATE public.agent_hub_agents SET last_verified_at = ts, last_seen_at = ts WHERE key = h.to_agent;

  IF p_session_id IS NOT NULL THEN
    INSERT INTO public.agent_hub_sessions (thread_id, agent_key, external_session_id, meta, updated_at)
    VALUES (h.thread_id, h.to_agent, p_session_id, coalesce(p_delivery, '{}'::jsonb), ts)
    ON CONFLICT (thread_id, agent_key)
      DO UPDATE SET external_session_id = EXCLUDED.external_session_id, meta = EXCLUDED.meta, updated_at = ts;
  END IF;

  RETURN jsonb_build_object('outcome', 'recorded', 'message', to_jsonb(m));
END;
$$;

-- 3c. Mark a handoff failed only if it is still open, in the same transaction as its status line.
--     Returns false (and writes nothing) when an answer or a cancel got there first.
CREATE OR REPLACE FUNCTION public.agent_hub_fail_handoff(p_handoff_id uuid, p_error text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  h public.agent_hub_handoffs%ROWTYPE;
BEGIN
  UPDATE public.agent_hub_handoffs
     SET status = 'FAILED', error = left(p_error, 2000)
   WHERE id = p_handoff_id AND status IN ('QUEUED', 'DELIVERED', 'IN_PROGRESS')
  RETURNING * INTO h;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.agent_hub_messages (thread_id, author, author_kind, kind, body, reply_to, handoff_id, context)
  VALUES (h.thread_id, 'agent-hub', 'system', 'SYSTEM',
          format('Handoff to %s failed: %s', h.to_agent, left(p_error, 1000)),
          h.source_message_id, h.id, jsonb_build_object('retryable', true));

  UPDATE public.agent_hub_threads t
     SET last_activity_at = now(),
         status = CASE
           WHEN t.status IN ('DONE', 'ARCHIVED') THEN t.status
           WHEN EXISTS (SELECT 1 FROM public.agent_hub_handoffs x
                         WHERE x.thread_id = h.thread_id AND x.status IN ('QUEUED', 'DELIVERED', 'IN_PROGRESS'))
             THEN 'WAITING_ON_AGENT'
           ELSE 'WAITING_ON_FENDI' END
   WHERE t.id = h.thread_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.agent_hub_record_response(uuid, text, text, jsonb, jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_hub_fail_handoff(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_hub_record_response(uuid, text, text, jsonb, jsonb, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_hub_fail_handoff(uuid, text) TO service_role;
