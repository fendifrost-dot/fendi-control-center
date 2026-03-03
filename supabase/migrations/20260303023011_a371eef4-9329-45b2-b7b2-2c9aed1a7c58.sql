CREATE OR REPLACE FUNCTION public.claim_outbox_rows(
  p_chat_id text,
  p_limit integer,
  p_now timestamptz
)
RETURNS TABLE(id uuid, kind text, payload jsonb, attempt_count integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE telegram_outbox t
  SET status = 'sending',
      last_attempt_at = p_now,
      attempt_count = t.attempt_count + 1,
      updated_at = p_now
  WHERE t.id IN (
    SELECT t2.id
    FROM telegram_outbox t2
    WHERE t2.chat_id = p_chat_id
      AND t2.status IN ('queued','failed')
      AND t2.next_attempt_at <= p_now
    ORDER BY t2.created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING t.id, t.kind, t.payload, t.attempt_count;
$$;