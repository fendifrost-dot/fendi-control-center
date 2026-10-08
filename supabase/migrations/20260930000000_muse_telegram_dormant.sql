-- Muse: reclassify Telegram as DORMANT / OPTIONAL TRANSPORT (2026-09-30)
--
-- Decision (Fendi, 2026-09-29): Telegram currently serves no operational purpose.
-- Operating chain is Fendi → Muse → Grok Bot → Claude / specialist agents → systems.
-- Telegram is outside that chain.
--
-- What this does
--   * muse_systems: telegram-webhook, telegram-outbox, approval-queue → is_active = false.
--     muse_system_health is defined `WHERE s.is_active`, so the three rows leave the
--     executive surface (health, brief system_failures, brief waiting) instead of
--     reading NEVER_RAN / STALE for a system that is not supposed to run.
--   * muse_open_loops: the seeded P1 "pending_route_clarifications schema conflict"
--     loop is a code-path risk inside dormant Telegram code. Parked (CANCELLED, P3)
--     with the reason in notes so it can be reopened if Telegram is reactivated.
--
-- What this deliberately does NOT do
--   * No Telegram code, tables, functions, queues or webhooks are dropped or altered.
--   * No telemetry probe is removed; the rows stay in muse_systems and can be
--     reactivated with a single UPDATE ... SET is_active = true.
--   * Daily Improvement Engine tables reference no system keys; nothing there to gate.
--
-- Idempotent: every statement is guarded on the current state.

UPDATE public.muse_systems
   SET is_active = false,
       blocker   = NULL,
       notes     = 'DORMANT / OPTIONAL TRANSPORT (2026-09-30). Retired from the active operating chain; preserved for possible future use. Not an active agent, not a core dependency, not part of the current execution chain. Reactivate only on Fendi''s explicit decision, a verified dependency from an active production system, or a future feature. ' || coalesce(notes, ''),
       updated_at = now()
 WHERE key IN ('telegram-webhook', 'telegram-outbox', 'approval-queue')
   AND is_active;

UPDATE public.muse_open_loops
   SET state    = 'CANCELLED',
       priority = 'P3',
       notes    = 'PARKED 2026-09-30: Telegram is DORMANT / OPTIONAL TRANSPORT; the affected code path (telegram-webhook) does not run. Reopen only if Telegram is reactivated. ' || coalesce(notes, ''),
       updated_at = now()
 WHERE title = 'Resolve the pending_route_clarifications schema conflict'
   AND state IN ('OPEN', 'IN_PROGRESS', 'WAITING', 'BLOCKED');
