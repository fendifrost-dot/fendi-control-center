-- Codify production hardening applied on 2026-09-30.
-- 1) Telegram is preserved but dormant / non-operational.
-- 2) client_aliases service-role policy is correctly scoped to service_role.

BEGIN;

-- Telegram is no longer part of the active operating chain. Unschedule the
-- legacy outbox flush if the job exists; leave code/tables intact for future use.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'telegram-outbox-flush') THEN
    PERFORM cron.unschedule('telegram-outbox-flush');
  END IF;
END $$;

UPDATE public.muse_systems
SET is_active = false,
    role = CASE key
      WHEN 'telegram-outbox' THEN 'Dormant optional notification transport'
      WHEN 'telegram-webhook' THEN 'Dormant optional command transport'
      ELSE role
    END,
    downstream_impact = NULL,
    blocker = NULL,
    data_status = 'KNOWN',
    notes = 'DORMANT / OPTIONAL TRANSPORT. Preserved for possible future use; not part of the active operating chain and should not generate executive alerts or improvement work.'
WHERE key IN ('telegram-outbox', 'telegram-webhook');

-- The original policy was named as service-role-only but was created without a
-- TO clause, which made it PUBLIC. Correct the policy to match its intent.
ALTER TABLE public.client_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow service role full access on client_aliases" ON public.client_aliases;
CREATE POLICY "Allow service role full access on client_aliases"
  ON public.client_aliases
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.client_aliases FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.client_aliases TO service_role;

COMMIT;
