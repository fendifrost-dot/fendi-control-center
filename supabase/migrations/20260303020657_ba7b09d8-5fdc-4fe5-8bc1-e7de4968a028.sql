
-- 1. Create table if not exists
CREATE TABLE IF NOT EXISTS public.telegram_outbox (
id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
chat_id text NOT NULL,
kind text NOT NULL,
payload jsonb NOT NULL,
status text NOT NULL DEFAULT 'queued',
attempt_count int NOT NULL DEFAULT 0,
last_error text,
dedupe_key text,
created_at timestamptz NOT NULL DEFAULT now(),
sent_at timestamptz,
next_attempt_at timestamptz NOT NULL DEFAULT now(),
last_attempt_at timestamptz,
updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Idempotent indexes
CREATE INDEX IF NOT EXISTS idx_telegram_outbox_status_created ON public.telegram_outbox (status, created_at);
CREATE INDEX IF NOT EXISTS idx_telegram_outbox_task_id ON public.telegram_outbox (task_id);
CREATE INDEX IF NOT EXISTS idx_telegram_outbox_due ON public.telegram_outbox (status, next_attempt_at);

-- 3. Partial unique index for de-duplication
CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_outbox_dedupe ON public.telegram_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- 4. Enable RLS
ALTER TABLE public.telegram_outbox ENABLE ROW LEVEL SECURITY;

-- 5. Idempotent RLS policy
DROP POLICY IF EXISTS "Authenticated full access" ON public.telegram_outbox;
CREATE POLICY "Authenticated full access"
ON public.telegram_outbox
FOR ALL
TO authenticated
USING (auth.uid() IS NOT NULL)
WITH CHECK (auth.uid() IS NOT NULL);

-- 6. Status CHECK constraint (idempotent)
DO $$ BEGIN
IF NOT EXISTS (
SELECT 1 FROM pg_constraint
WHERE conname = 'telegram_outbox_status_check'
AND conrelid = 'public.telegram_outbox'::regclass
) THEN
ALTER TABLE public.telegram_outbox
ADD CONSTRAINT telegram_outbox_status_check
CHECK (status IN ('queued', 'sending', 'sent', 'failed'));
END IF;
END $$;

-- 7. updated_at trigger (idempotent)
DROP TRIGGER IF EXISTS update_telegram_outbox_updated_at ON public.telegram_outbox;
CREATE TRIGGER update_telegram_outbox_updated_at
BEFORE UPDATE ON public.telegram_outbox
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
