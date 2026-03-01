
-- Idempotent: tool_execution_logs table
CREATE TABLE IF NOT EXISTS public.tool_execution_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id text NOT NULL,
  tool_name text NOT NULL,
  args jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'attempted'
    CONSTRAINT tool_execution_logs_status_check CHECK (status IN ('attempted', 'succeeded', 'failed')),
  error text,
  elapsed_ms integer,
  model text,
  chat_id text,
  user_message text,
  http_status integer,
  response_json jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_request_id ON public.tool_execution_logs (request_id);
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_tool_name ON public.tool_execution_logs (tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_status ON public.tool_execution_logs (status);
CREATE INDEX IF NOT EXISTS idx_tool_exec_logs_started_at ON public.tool_execution_logs (started_at DESC);

-- Enable RLS
ALTER TABLE public.tool_execution_logs ENABLE ROW LEVEL SECURITY;

-- Authenticated SELECT only (read logs in-app). No open write policy.
-- Service role bypasses RLS, so the edge function can write without a policy.
CREATE POLICY "Authenticated users can view tool execution logs"
  ON public.tool_execution_logs
  FOR SELECT
  USING (auth.uid() IS NOT NULL);
