
-- =============================================
-- Phase 1: sessions + tasks (deterministic spine)
-- Idempotent — safe to re-run
-- =============================================

-- 1. sessions table
CREATE TABLE IF NOT EXISTS public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL DEFAULT 'telegram',
  channel_user_id text NOT NULL,
  active_model text NOT NULL DEFAULT 'grok',
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_sessions_channel_user'
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT uq_sessions_channel_user UNIQUE (channel, channel_user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sessions' AND policyname = 'Authenticated full access'
  ) THEN
    CREATE POLICY "Authenticated full access" ON public.sessions
      FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
  END IF;
END $$;

-- 2. tasks table
CREATE TABLE IF NOT EXISTS public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES public.sessions(id) ON DELETE CASCADE NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  requested_model text,
  request_text text NOT NULL,
  selected_workflow text,
  selected_tools jsonb DEFAULT '{}'::jsonb,
  result_json jsonb DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

-- Safe NOT NULL enforcement (no-op if already NOT NULL)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.tasks WHERE session_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot SET NOT NULL: tasks.session_id has NULL rows. Backfill or delete them first.';
  END IF;
  ALTER TABLE public.tasks ALTER COLUMN session_id SET NOT NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'tasks' AND policyname = 'Authenticated full access'
  ) THEN
    CREATE POLICY "Authenticated full access" ON public.tasks
      FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
  END IF;
END $$;

-- 3. TG_OP-aware status validation
CREATE OR REPLACE FUNCTION public.validate_task_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('queued', 'running', 'succeeded', 'failed') THEN
      RAISE EXCEPTION 'Invalid initial task status: %', NEW.status;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('succeeded', 'failed') THEN
      RAISE EXCEPTION 'Cannot transition from terminal status: %', OLD.status;
    END IF;
    IF NEW.status NOT IN ('queued', 'running', 'succeeded', 'failed') THEN
      RAISE EXCEPTION 'Invalid task status: %', NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_task_status ON public.tasks;
CREATE TRIGGER trg_validate_task_status
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.validate_task_status();

-- 4. updated_at triggers
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sessions_updated_at ON public.sessions;
CREATE TRIGGER trg_sessions_updated_at
  BEFORE UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_tasks_updated_at ON public.tasks;
CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5. Indexes
CREATE INDEX IF NOT EXISTS idx_tasks_session_status ON public.tasks (session_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON public.tasks (created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_channel_user ON public.sessions (channel, channel_user_id);
