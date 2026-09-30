-- MUSE WORKBOARD WRITE AUDIT
-- Idempotency + audit for the scoped muse-workboard mutation surface.
-- No plaintext bearer token is stored here.

CREATE TABLE IF NOT EXISTS public.muse_workboard_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_label text NOT NULL,
  request_key text NOT NULL,
  action text NOT NULL,
  http_status integer NOT NULL,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT muse_workboard_requests_key_unique UNIQUE (token_label, request_key),
  CONSTRAINT muse_workboard_requests_action_check CHECK (action IN (
    'create_mission',
    'create_improvement',
    'create_task',
    'append_update',
    'record_measurement',
    'update_task_state',
    'update_task_verification',
    'update_improvement_state'
  ))
);

CREATE INDEX IF NOT EXISTS muse_workboard_requests_created_idx
  ON public.muse_workboard_requests(created_at DESC);

ALTER TABLE public.muse_workboard_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON public.muse_workboard_requests;
CREATE POLICY "Service role full access"
  ON public.muse_workboard_requests
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.muse_workboard_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.muse_workboard_requests TO service_role;

COMMENT ON TABLE public.muse_workboard_requests IS
  'Service-role-only idempotency and audit ledger for the scoped Muse workboard writer. request_key prevents duplicate agent delegations on retries.';
