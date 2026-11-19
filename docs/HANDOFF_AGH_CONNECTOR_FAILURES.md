# Handoff — AGH connector failures (playlist `needs_reconnect`, sync never installed)

Written 2026-11-07 from the 12:00 PM CT consolidated report. Everything below was verified
against the live Hub database through the Lovable MCP (`query_database` on project
`4778d2a5-781c-45e5-b165-9497cdba4918`) and against the live edge endpoints. Nothing in this
file is a guess, and **nothing in this file has been fixed yet.**

The AGH / FanFuel Hub code lives in `fendifrost-dot/fan-growth-pilot`, not in this repo. This
handoff sits here because the session that wrote it had push access to Control Center only.
The one code artifact (a migration) is staged at
[`docs/agh/20261107190000_mcp_oauth_sliding_refresh.sql`](agh/20261107190000_mcp_oauth_sliding_refresh.sql)
and belongs in `fan-growth-pilot/supabase/migrations/`.

---

## Status going in

| Thing | State |
|---|---|
| `mcp-playlist-discovery` edge function | ✅ live — `POST /mcp` without a bearer returns `401 missing_bearer` with a correct `WWW-Authenticate` header |
| `mcp-sync-discovery` edge function | ✅ live — same `401` behaviour; OAuth metadata at `/.well-known/oauth-authorization-server` returns `200` with `scopes_supported: ["sync_discovery"]` |
| Consent pages `/admin/mcp-playlist-authorize` and `/admin/mcp-sync-authorize` | ✅ published — both route names are present in the live `index-*.js` bundle at `fan-growth-pilot.lovable.app` |
| **AGH Playlist Discovery** connector on claude.ai | ✅ reconnected 2026-11-09 — live family, expires 2026-12-09 16:24Z (30-day cap still in force, see Step 4) |
| **AGH Sync Discovery** connector on claude.ai | ✅ installed and authorized 2026-11-09 — live family, expires 2026-12-09 16:38Z; the 8:30a station on 2026-11-12 wrote targets, verifications and opportunities through it |
| Sync connector attached to the 8:30a and 12:00p scheduled tasks | ✅ in effect — the 2026-11-12 8:30a station used it (note: `list_triggers.mcp_connections` still lists only the playlist connector on those tasks, so that field is not the source of truth) |
| Sliding-refresh migration | 📝 staged in this repo, validated on a local Postgres 16, **not applied** (`pg_get_functiondef` on 2026-11-12 still has no `interval '30 days'`), **not committed to fan-growth-pilot** — both connectors will die again 2026-12-09 without it |
| `agh_handoff_batches` counter columns (`advance_sync_batch` schema error) | ✅ **applied 2026-11-12 14:36Z** via the Lovable SQL path — see Step 5 |
| Station cron DST drift (fired 1h early since 2026-11-01) | ✅ **fixed 2026-11-12** — see Step 6 |
| `CLAUDE_AGENT_SECRET` | not involved in either failure; do not check it, do not provision it |
| Runway connector `needs_reconnect` | unrelated to AGH; ignore for this handoff |

## Root cause, with the rows

**Playlist.** `_shared/mcp-oauth.ts` sets `REFRESH_TOKEN_MAX_LIFETIME_MS = 30 days` at
authorize time, and the `agh_mcp_rotate_oauth_refresh` RPC copies that *original* expiry onto
every rotated token (`refresh_expires_at => v_tok.refresh_expires_at`). So an hourly-refreshing
connector still dies exactly 30 days after Fendi's one click:

| Event | Timestamp (UTC) |
|---|---|
| Fendi authorized the current client `agh-pd-d4efa7136597f1cc` | 2026-10-08 14:38:36 |
| `refresh_expires_at` on **every** token in that family | 2026-11-07 14:38:36 |
| Last successful rotation (8:30a station) | 2026-11-07 13:31:07 |
| That access token expired | 2026-11-07 14:31:07 |
| 10:15a CT "Daily playlist pitching" run tried to refresh → RPC returned `refresh_expired` and revoked the row | 2026-11-07 16:15:39 |
| `live_families` for `playlist_discovery` now | **0** |

That is why the connector was live at 14:07Z and gone by the 17:07Z station. It is not an
outage and not a credential problem. The same thing will happen again 30 days after the next
reconnect unless Step 4 is applied.

**Sync.** Not a reconnect case. The server has been deployed and answering since at least
2026-09-11 (`HANDOFF_SYNC_OPERATING_STACK.md` step 5 — "Fendi authorizes Claude sync MCP
once" — was never done). Every daily station since has reported "AGH Sync Discovery connector
not attached to this routine" because there is nothing to attach.

## Hard rules

* ❌ No `supabase` CLI — a 403 there is a **false wall**.
* ❌ No supabase.com dashboard. SQL goes through **Lovable → SQL Editor** (or the Lovable MCP
  `query_database`, which is the same path).
* ❌ Don't ask Fendi to paste SQL. The agent has the SQL (Step 4), it runs it.
* ❌ Never ask for, print, or invent a secret. Both connectors are OAuth-only; consent is
  Fendi's signed-in Hub session, one click.
* ✅ Edge functions redeploy via **Lovable → Edge Functions**. Frontend via **Lovable → Publish**.
  Neither is needed for this handoff — both functions and the consent pages are already live.

## Coordinates

| | |
|---|---|
| Hub repo | `fendifrost-dot/fan-growth-pilot` |
| Lovable project id | `4778d2a5-781c-45e5-b165-9497cdba4918` (FanFuel Hub) |
| Supabase project (Lovable Cloud) | `vsemrziqxrrfcquxfnwd` |
| Playlist MCP URL (already installed) | `https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/mcp-playlist-discovery/mcp` |
| **Sync MCP URL (to install)** | `https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/mcp-sync-discovery/mcp` |
| Scheduled tasks that need the sync connector | `trig_01Jy8EZiyYhwFaDJAnQMjUF3` (AGH 8:30a) and `trig_0143i8GiFQzZJcbJCYY6trrE` (AGH 12:00p) |
| Migration to apply | `docs/agh/20261107190000_mcp_oauth_sliding_refresh.sql` (this repo) → `supabase/migrations/` (fan-growth-pilot) |
| Test to update | `fan-growth-pilot/supabase/functions/_shared/playlist-discovery-mcp.test.ts` (rotate mock, see Step 4b) |

---

## Step 1 — Reconnect AGH Playlist Discovery (Fendi, ~1 minute)

This is a user action on claude.ai; no agent can do it.

1. Be signed in to `https://fan-growth-pilot.lovable.app` as Fendi in the same browser
   (the consent page only accepts the artist user; anyone else gets
   `only_fendi_may_authorize_connector`).
2. claude.ai → **Settings → Connectors → AGH Playlist Discovery → Reconnect**.
3. It redirects to `/admin/mcp-playlist-authorize`. Click **Authorize**.

### Step 1a — Verify it landed

Lovable SQL editor (or `query_database`):

```sql
select scope, count(*) filter (where revoked_at is null and refresh_expires_at > now()) as live_families,
       max(created_at) as last_issued, max(refresh_expires_at) as family_expires
from public.agh_mcp_oauth_tokens group by scope;
```

**Expected exactly:** a `playlist_discovery` row with `live_families = 1`, `last_issued` within
the last few minutes, and `family_expires` ≈ now + 30 days. `live_families = 0` means the
Authorize click did not complete — redo Step 1, do not touch the table.

Then `ListConnectors` in a fresh session: `AGH Playlist Discovery` must show
`installState: connected`. The next station (4:30a CT) will prove it end to end; its run log
must open with `start_claude_playlist_station` succeeding, not `BLOCKED_NO_CREDENTIAL`.

## Step 2 — Install AGH Sync Discovery (Fendi, ~2 minutes)

1. claude.ai → **Settings → Connectors → Add custom connector**.
   Name: `AGH Sync Discovery`. URL: `https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/mcp-sync-discovery/mcp`.
   Leave OAuth client id/secret blank — the server supports dynamic client registration.
2. Connect. It redirects to `/admin/mcp-sync-authorize`; click **Authorize** (signed in as Fendi).

### Step 2a — Verify it landed

```sql
select count(*) as sync_live
from public.agh_mcp_oauth_tokens
where scope = 'sync_discovery' and revoked_at is null and refresh_expires_at > now();
```

**Expected exactly:** `sync_live = 1`. Today it is `0` (and the table has never held a
`sync_discovery` row). `ListConnectors` must now list `AGH Sync Discovery` as `connected`, and
`tools/list` through it must return these 9 tools:
`get_sync_discovery_work, submit_sync_targets, submit_sync_opportunities, create_sync_drafts,
verify_sync_contacts, advance_sync_batch, start_claude_sync_station,
complete_claude_sync_station, get_own_sync_batches`.

## Step 3 — Attach the sync connector to the two stations (Fendi or an agent with the scheduled-tasks UI)

`update_trigger` cannot change a task's connectors, so this is done in the claude.ai
scheduled-tasks UI: open **AGH 8:30a — final playlist tranche + sync discovery opens** and
**AGH 12:00p — sync batch due** and add **AGH Sync Discovery** to each task's connectors. Do
not recreate the tasks (that loses run history and the 4:30a / 7:00a tasks do not need it).

### Step 3a — Verify

`list_triggers` → both tasks' `mcp_connections` include an entry named `AGH_Sync_Discovery`
alongside the existing `AGH_Playlist_Discovery`. The next 12:00p station must then open a sync
station via `start_claude_sync_station` and report the batch as **DELIVERED** (`AWAITING_AGH_IMPORT`
on a stored Hub batch), not "connector not attached".

## Step 4 — Stop the 30-day recurrence (agent with fan-growth-pilot push access)

### Step 4a — Commit and apply the migration

1. Copy `docs/agh/20261107190000_mcp_oauth_sliding_refresh.sql` from this repo to
   `fan-growth-pilot/supabase/migrations/20261107190000_mcp_oauth_sliding_refresh.sql`,
   unchanged.
2. Paste it into **Lovable → SQL Editor** on the FanFuel Hub project and run it.

It is a `create or replace function` on `agh_mcp_rotate_oauth_refresh` with one behavioural
change: each successful rotation sets `refresh_expires_at = now() + 30 days` instead of copying
the family's original expiry. Access-token TTL (1 h), one-time rotation, client binding,
revocation and the `refresh_expired` path are unchanged. The edge function needs no redeploy —
it reads `refresh_expires_at` from the RPC result.

Validated 2026-11-07 on a local Postgres 16 against the real table shape: rotation extends the
family (`extended = t`), old refresh revoked, replaying the old refresh → `invalid_grant`,
wrong client → `client mismatch`, expired family → `refresh_expired`.

### Step 4b — Update the test mock

In `supabase/functions/_shared/playlist-discovery-mcp.test.ts`, the `agh_mcp_rotate_oauth_refresh`
mock preserves the old expiry (`const preserved = tok.refresh_expires_at;`). Change it to mirror
the new RPC:

```ts
const preserved = new Date(Date.now() + REFRESH_TOKEN_MAX_LIFETIME_MS).toISOString();
```

(`REFRESH_TOKEN_MAX_LIFETIME_MS` is already imported in that file.) Then run the Deno test
`full OAuth authorization-code + PKCE + refresh rotation + revocation`; it must still pass.

### Step 4c — Verify on the live database

```sql
select position('interval ''30 days''' in pg_get_functiondef('public.agh_mcp_rotate_oauth_refresh'::regproc)) > 0 as sliding;
```

**Expected exactly:** `sliding = t`. `f` means the paste did not run.

Then, one hour or more after Step 1 (so at least one rotation has happened):

```sql
select refresh_expires_at > now() + interval '29 days' as extended
from public.agh_mcp_oauth_tokens
where scope = 'playlist_discovery' and revoked_at is null
order by created_at desc limit 1;
```

**Expected exactly:** `extended = t`. `f` means rotations are still inheriting the old expiry.

## Final step — Record what is now true

Only after Steps 1a, 2a, 3a and 4c print the expected values: update the status table at the
top of this file, and add one line to `fan-growth-pilot/docs/agh-rules/agh-playlist-supply-blockers.md`
saying the connectors expire only after 30 idle days, so a `needs_reconnect` after this date is
a real event to report, not a monthly tax.

## Step 5 — `advance_sync_batch` schema defect (DONE 2026-11-12, recorded here for the ledger)

**Symptom (5 days, 7 stations, 11 failed calls, 11-09 → 11-12):** every `advance_sync_batch` call
returned verbatim `Could not find the 'approved_count' column of 'agh_handoff_batches' in the schema
cache`, while `submit_sync_targets`, `verify_sync_contacts` and `submit_sync_opportunities` succeeded
in the same runs. 121 `sync_research_targets` and 45 `sync_research_opportunities` sat with
`batch_id null`; zero `batch_kind = 'sync'` rows had ever existed in `agh_handoff_batches`.

**Root cause:** `fan-growth-pilot/supabase/migrations/20260911150000_sync_operating_stack.sql` was
applied to the live Hub *except* its lines 252–262, the `alter table public.agh_handoff_batches add
column if not exists …` block (nine columns: `raw_count`, `verified_count`, `opportunity_count`,
`drafted_count`, `approved_count`, `submitted_count`, `rejected_count`, `response_count`,
`source_evidence_summary`). Every other object in that migration (sync tables, `batch_id` columns,
OAuth constraint and RPCs) was present. `_shared/sync-research.ts` `advanceSyncBatch()` inserts all
nine, so PostgREST rejected the insert before any row was written.

**Fix applied (2026-11-12 14:36Z, Lovable `query_database` = the Lovable SQL editor path):** that
block, verbatim, plus `notify pgrst, 'reload schema'`. No code change, no redeploy: the committed
migration was simply not fully applied. Nothing new needs committing to `fan-growth-pilot`.

**Verified, from real output:**

```sql
select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
where table_schema='public' and table_name='agh_handoff_batches'
  and column_name in ('raw_count','verified_count','opportunity_count','drafted_count',
                      'approved_count','submitted_count','rejected_count','response_count','source_evidence_summary');
```
→ all nine returned, `int not null default 0` / `text`.

* A `do $$ … insert into agh_handoff_batches (… the exact column set `advanceSyncBatch` uses …);
  raise exception 'ROLLBACK_PROBE_OK'; $$` block raised `ROLLBACK_PROBE_OK` — i.e. the insert
  succeeded and was rolled back; no probe row exists.
* PostgREST schema cache, with the app's public anon key:
  `GET /rest/v1/agh_handoff_batches?select=approved_count&limit=1` → `200`; same for
  `response_count` and `source_evidence_summary`; control `select=no_such_column_xyz` → `400`.

**What the next sync station must show:** `advance_sync_batch` returns a batch id, and
`select count(*) from public.agh_handoff_batches where batch_kind='sync'` goes from `0` to `≥ 1`.
The ~66 stranded targets / ~24 opportunities from 11-09 → 11-12 are batchable by id; batching
them is the station's (or Fendi's) call, not this handoff's.

## Step 6 — Station schedule DST drift (DONE 2026-11-12)

All four AGH station tasks were pinned to UTC and fired an hour early since DST ended on
2026-11-01 (the "8:30a" station fired at 07:33 CT). Rewritten with `CRON_TZ=America/Chicago` at
their labelled times: 4:30a `30 4`, 7:00a `0 7`, 8:30a `30 8`, 12:00p `0 12`. Verify with
`list_triggers`: each `cron_expression` starts with `CRON_TZ=America/Chicago`.

## Still open after 2026-11-12

1. **Step 4 (sliding refresh)** — both connector families expire **2026-12-09**. Needs a session with
   `fan-growth-pilot` push access to commit `docs/agh/20261107190000_mcp_oauth_sliding_refresh.sql`
   as a migration there, then apply it via Lovable SQL.
2. The sync-lane asks that are Fendi's, from the 11-12 sync log: the Meditate `sync_eligible`
   approval record, the Wizards DMV-connection answer, dedupe-key normalisation (a `fan-growth-pilot`
   code change), and retiring the four stub target rows named there.

---

## Report back

1. Which of Steps 1–4 you executed, by name, and which buttons/commands.
2. The actual output of 1a, 2a, 3a and 4c (the numbers, not "passed").
3. The first station run log after the fix: did it open a playlist station and a sync station,
   and was the sync batch DELIVERED.
4. Anything that came back unhealthy — that is a finding about the live system.

## Do not

* Do not edit the migration to make it run. If the Lovable SQL editor errors, report the error
  verbatim — the live function differs from what was validated, and that is the finding.
* Do not insert, update or delete rows in `agh_mcp_oauth_tokens` by hand to "reconnect". Only
  the OAuth flow may mint a token.
* Do not widen `isAllowedRedirectUri`, loosen `authorizeFendiSession`, or add a secret-based
  bypass to get past a consent error.
* Do not report Step 1 or 2 as done because a reconnect button was clicked — only the SQL
  counts in 1a / 2a prove it.
* Do not touch the Runway connector; it is unrelated.
