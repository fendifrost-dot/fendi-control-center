# Handoff — Muse Daily Improvement Engine

## Status

Implementation is on branch `chatgpt/muse-daily-improvement-engine`.

This change is additive. It does not replace the existing Muse executive layer.

## Deploy order

1. Apply `supabase/migrations/20260929160000_muse_daily_improvement_engine.sql`.
2. Apply `supabase/migrations/20260929161000_muse_daily_improvement_view_fixes.sql`.
3. Apply `supabase/migrations/20260929161500_muse_work_updates_append_only.sql`.
4. Run `scripts/muse/verify-daily-improvement-engine.sql`.
5. Redeploy `muse-executive` so the six additional read resources become available.
6. Publish the frontend.

## Expected UI routes

- `/muse/missions`
- `/muse/daily`
- `/muse/agents`
- `/muse/impact`

Existing Muse routes must remain working.

## Expected executive resources

- `/executive/missions`
- `/executive/daily-improvements`
- `/executive/agent-queue`
- `/executive/verification-queue`
- `/executive/improvement-results`
- `/executive/work-feed`

## Security invariants

- `muse-executive` remains GET-only.
- Existing Muse read token does not gain write scope.
- `muse_work_updates` is append-only for authenticated operators.
- Domain systems remain authoritative for operational truth.
- No agent completion claim bypasses verification.

## Known deliberate limitation

External Muse/Grok/Claude write access is NOT introduced in this tranche. Agent mutation must go through an approved, scoped Control Center execution path rather than widening the public executive API.

---

## Deployment record — 2026-09-29 (Claude, Lovable SQL editor + Lovable chat)

**Status: PARTIAL — schema, edge function and frontend are deployed; live API/UI verification is blocked by a Control Center REST outage (below).**

### Done and verified

| Step | Result | Evidence |
|---|---|---|
| `20260929160000` | ✅ applied | full 323-line file, `Query succeeded` (first attempt failed with *connection timeout* before executing; probe showed nothing applied; retry succeeded) |
| `20260929161000` | ✅ applied | `Query succeeded`; `pg_get_viewdef` shows `count(DISTINCT …)` on `muse_mission_board` and correlated subqueries on `muse_daily_improvement_board` — **count-inflation fix confirmed** |
| `20260929161500` | ✅ applied | policies on `muse_work_updates`: authenticated read + append, service role all; "Authenticated full access" gone |
| `20260929170000` (#32, new) | ✅ applied | revokes `TRUNCATE/TRIGGER/REFERENCES` from `authenticated` on `muse_work_updates` and `muse_access_audit` (TRUNCATE bypasses RLS; found live) |
| verifier | ✅ passes | `verify-daily-improvement-engine.sql` from `540a63c` (psql `\echo` lines removed — the web editor cannot run meta-commands). Post-fix grants: `muse_work_updates` = INSERT, SELECT; `muse_access_audit` = SELECT |
| columns / constraints / RLS | ✅ | 16/16 new `muse_improvements` columns; 3/3 new constraints; RLS on all 4 new tables; 0 anon grants |
| no fake data | ✅ | new tables 0/0/0/0 rows; views 0/2/0/0/2/0 (the 2 are pre-existing improvements) |
| `muse-executive` | ✅ redeployed from `540a63c` (Lovable chat, only that function) | unauthenticated GET on new resources → 401; POST/PUT/PATCH/DELETE → 405 |
| frontend | ✅ published (Lovable → Publish → Publish changes) | live bundle `index-C8yKJXM9.js` contains `/muse/missions`, `/muse/daily`, `/muse/agents`, `/muse/impact` plus the six existing routes |

### Not verified (blocked)

* New and old executive resources returning **data** with a valid token.
* Signed-in rendering of the new pages.

### Incident: REST API down after the schema change (started ≤ 22:58 UTC)

Every PostgREST request — Muse or not (e.g. `telegram_outbox`) — returns
`503 PGRST002 "Could not query the database for the schema cache. Retrying."`.
The DDL triggered a schema-cache reload; on the Tiny instance the reload's queries
(`SELECT name FROM pg_timezone_names` observed at 43 s, then the base-types
introspection query) do not complete within `authenticator`'s `statement_timeout = 8s`,
so every retry is cut off. Direct SQL worked intermittently; the SQL editor later hit
connection timeouts too. Auth (`/auth/v1/health`) and edge functions were up.
Lovable's disk graph shows pressure in 7 of the last 24 hours; CPU and memory never flagged.
Still down at 23:17 UTC.

**Remedies, in order of certainty:** (1) resize the instance (Lovable → Cloud → Advanced
settings → Database size); (2) once SQL is reachable, raise `authenticator`'s statement
timeout so the schema cache can load (`ALTER ROLE authenticator SET statement_timeout = '30s'; NOTIFY pgrst, 'reload config'; NOTIFY pgrst, 'reload schema';`) — a production
config change that needs the owner's approval.

**Next:** after REST recovers, run `scripts/muse/verify-muse-live.mjs` with a valid
`MUSE_API_TOKEN`, then check the new pages while signed in.

### Incident resolution — 2026-09-29 23:30–23:55 UTC

**Recovery action (owner-approved):** `ALTER ROLE authenticator SET statement_timeout = '60s';`
applied at 23:30:10 UTC. No reload notifications sent; PostgREST picked the setting up on its
next reconnect. No sessions terminated, no database restart, no schema changes.

**Timeline:** first non-503 at 23:35:04 (a 500 `57014` on the first real query), first 200 at
23:35:31 UTC — **≈5 min after the ALTER, ≈37 min total outage**. So the schema-cache load
completed somewhere in the 8–60 s window; the exact figure isn't exposed, but it exceeded the
old 8 s ceiling on every attempt for 30+ minutes and fit inside 60 s within minutes.

**Post-recovery checks:**

| Check | Result |
|---|---|
| Existing REST (unrelated tables) | ✅ `telegram_outbox`, `remote_command_queue`, `tasks`, `drive_sync_events`, `pending_guardian_events`, `telegram_webhook_processed_updates` all 200 |
| Muse old resources (with token) | ✅ `systems` 21 rows · `open-loops` 13 · `brief` 10 (brief took 47.6 s) |
| Muse new resources (with token) | ✅ all six 200 — `missions` 0 · `daily-improvements` 2 · `agent-queue` 0 · `verification-queue` 0 · `improvement-results` 2 · `work-feed` 0; empty sets report `NOT_MEASURED`, never zero |
| Security | ✅ unauth 401 · POST/PUT/PATCH/DELETE 405 · anon REST on `muse_work_feed` 401 |
| Auth | ✅ `/auth/v1/health` 200 |
| Data integrity | ✅ counts unchanged from pre-outage: outbox 1201 · drive_events 736 · tasks 416 · ingestion 208 · muse 8/13/2/1 |
| Signed-in UI render | ❌ still unverified — browser not signed in (`/muse/missions` → `/login`) |

**Residual:** the database is still slow (single REST reads 1–29 s, occasional `57014` under
`anon`'s 3 s limit, SQL editor connect timeouts). REST is *up*, not *fast*.

**Timeout rollback decision:** do **not** reset to 8 s yet. The schema-cache load needed >8 s on
every attempt for 30+ min; resetting would re-arm the identical failure on the next migration.
Hold 60 s until disk pressure is addressed or a reload is observed completing well under 8 s.
