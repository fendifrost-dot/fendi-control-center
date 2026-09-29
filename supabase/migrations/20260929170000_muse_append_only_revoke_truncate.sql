-- Close the TRUNCATE gap in the two append-only Muse tables.
--
-- 20260929161500 revoked UPDATE/DELETE on muse_work_updates, and the executive
-- layer revoked INSERT/UPDATE/DELETE on muse_access_audit, but Supabase's
-- default privileges also grant TRUNCATE, TRIGGER and REFERENCES to
-- `authenticated` on every new public table. TRUNCATE empties a table without
-- consulting row-level security, so it defeats "append-only" outright.
--
-- Idempotent: REVOKE of a privilege that is not held is a no-op.

REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.muse_work_updates FROM authenticated;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.muse_access_audit FROM authenticated;
REVOKE ALL ON public.muse_work_updates FROM anon, PUBLIC;
REVOKE ALL ON public.muse_access_audit FROM anon, PUBLIC;
