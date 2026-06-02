-- Remote Control Hub: command queue from phone (Telegram / web) → local Mac bridge daemon.

CREATE TABLE IF NOT EXISTS public.remote_bridge_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_name text NOT NULL,
  last_seen_at timestamptz,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'remote_bridge_devices_status_check'
      AND conrelid = 'public.remote_bridge_devices'::regclass
  ) THEN
    ALTER TABLE public.remote_bridge_devices
      ADD CONSTRAINT remote_bridge_devices_status_check
      CHECK (status IN ('active', 'revoked'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.remote_command_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid REFERENCES public.remote_bridge_devices(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'telegram',
  source_ref text,
  command_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  reply_chat_id text,
  result_json jsonb,
  error text,
  claimed_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_remote_command_queue_poll
  ON public.remote_command_queue (status, created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_remote_command_queue_device
  ON public.remote_command_queue (device_id, status, created_at);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'remote_command_queue_status_check'
      AND conrelid = 'public.remote_command_queue'::regclass
  ) THEN
    ALTER TABLE public.remote_command_queue
      ADD CONSTRAINT remote_command_queue_status_check
      CHECK (status IN ('queued', 'claimed', 'running', 'completed', 'failed', 'cancelled'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'remote_command_queue_type_check'
      AND conrelid = 'public.remote_command_queue'::regclass
  ) THEN
    ALTER TABLE public.remote_command_queue
      ADD CONSTRAINT remote_command_queue_type_check
      CHECK (command_type IN ('shell', 'cursor_agent', 'claude', 'open_url', 'notify', 'ping'));
  END IF;
END $$;

ALTER TABLE public.remote_bridge_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remote_command_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated full access remote_bridge_devices" ON public.remote_bridge_devices;
CREATE POLICY "Authenticated full access remote_bridge_devices"
  ON public.remote_bridge_devices FOR ALL TO authenticated
  USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated full access remote_command_queue" ON public.remote_command_queue;
CREATE POLICY "Authenticated full access remote_command_queue"
  ON public.remote_command_queue FOR ALL TO authenticated
  USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);

DROP TRIGGER IF EXISTS update_remote_bridge_devices_updated_at ON public.remote_bridge_devices;
CREATE TRIGGER update_remote_bridge_devices_updated_at
  BEFORE UPDATE ON public.remote_bridge_devices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_remote_command_queue_updated_at ON public.remote_command_queue;
CREATE TRIGGER update_remote_command_queue_updated_at
  BEFORE UPDATE ON public.remote_command_queue
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.claim_remote_command_rows(
  p_device_id uuid,
  p_limit integer,
  p_now timestamptz
)
RETURNS TABLE(
  id uuid,
  command_type text,
  payload jsonb,
  reply_chat_id text,
  source text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE remote_command_queue q
  SET status = 'claimed',
      claimed_at = p_now,
      updated_at = p_now
  WHERE q.id IN (
    SELECT q2.id
    FROM remote_command_queue q2
    WHERE q2.status = 'queued'
      AND q2.expires_at > p_now
      AND (q2.device_id IS NULL OR q2.device_id = p_device_id)
    ORDER BY q2.created_at ASC
    LIMIT GREATEST(1, LEAST(p_limit, 10))
    FOR UPDATE SKIP LOCKED
  )
  RETURNING q.id, q.command_type, q.payload, q.reply_chat_id, q.source;
$$;
