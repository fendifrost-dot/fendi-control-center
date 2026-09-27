# Handoff — deploy the Muse executive layer in Lovable

**For:** a Claude agent with browser tools (or Fendi, clicking through it manually).
**Goal:** take Muse from `CLAIMED` to `LIVE_VERIFIED`. The code is already merged to `main`;
nothing in this handoff writes code.

Design reference: [`docs/MUSE_EXECUTIVE_LAYER.md`](./MUSE_EXECUTIVE_LAYER.md).

---

## Status — COMPLETE (2026-09-26, 22:30 UTC)

**Steps 1, 1a, 2, 3, 5 and 6 are all DONE and verified. Do not re-run this handoff.**

> ⚠️ **Once the v2 mission-board migration (`20260927120000_muse_mission_board.sql`) is applied,
> this v1 file must never be re-run on its own** — its views have fewer columns than v2's and it
> will stop with `cannot drop columns from view`. Re-run the v2 file instead; it is idempotent.
> See [`HANDOFF_MUSE_MISSION_BOARD_DEPLOY.md`](./HANDOFF_MUSE_MISSION_BOARD_DEPLOY.md).
Re-running the migration is harmless (it is idempotent) but it is unnecessary load on a
Tiny Lovable Cloud instance.

| Thing | State | Evidence |
|---|---|---|
| Code on `main` | ✅ | #19 `b576721` … #23 `0d899b8` |
| Schema in the live database | ✅ applied | Full migration re-run in one pass in the Lovable SQL editor, `Query succeeded` |
| Step 1a counts | ✅ exact | `tables=11, views=11, domains=8, systems=21, open_loops=13, decisions=4, kpis=19, sources=13` |
| `muse-executive` edge function | ✅ `LIVE_VERIFIED` | verifier sections 2–3 |
| `/muse` UI published | ✅ `LIVE_VERIFIED` (deployed) | `fendi-control-center.lovable.app` serves bundle `index-C2yrT4DR.js` containing `/muse`, `/muse/portfolio`, `/muse/loops`, `/muse/improvements`, `/muse/sources`, `/muse/systems` |
| Live verification (step 5) | ✅ | `MUSE LIVE VERIFICATION PASSED` — 17 pass, 0 fail, 1 skip (data-shape checks skipped: no `MUSE_API_TOKEN`) |
| Muse ledger (step 6) | ✅ | `muse-executive` + `/muse` → `LIVE_VERIFIED`; migration → `SYSTEM_VERIFIED`; deploy open loop → `RESOLVED`; source authority `last_verified_at` stamped. `verified_by = claude-cowork` |

### `muse_system_health` at 2026-09-26 22:28 UTC (first live read)

No system reports `FAILING`. One reports `STALE`:

| System | Status | Evidence |
|---|---|---|
| `remote-bridge` | **STALE** | 30-min heartbeat; last success `2026-06-09T17:30:11Z`, no failures recorded |
| `cc-tool-executor` | HEALTHY, `failing_count=1` | last failure `2026-09-23T20:11Z` (Runway: "`ratio` may only be provided in reference mode"), last success after it `2026-09-24T00:07Z` |
| `ingestion-jobs` | NEVER_RAN / NOT_MEASURED | 208 pending, latest activity `2026-04-01` |
| `statement-chunk-jobs` | NEVER_RAN / NOT_MEASURED | 2 pending |
| `drive-sync`, `telegram-webhook`, `telegram-outbox`, `agent-task-loop` | HEALTHY | — |
| `guardian-queue`, `workflow-runner`, `remote-command-queue`, `approval-queue` | NEVER_RAN / NOT_MEASURED | 0 pending |
| Boltz ×4, AGH, GitHub, Lovable deploys, Claude Code, Cursor | NOT_OBSERVED / SOURCE_EXISTS_ACCESS_NEEDED | correct by design — Phase 2 |

### Still open (not blockers)

1. ~~**Step 4 (optional):** no `MUSE_API_TOKEN` exists.~~ **Done 2026-09-26 23:28 UTC.**
   Token row `label='thoth'`, `scopes={read}`, `expires_at=NULL` (no expiry, by Fendi's
   choice; rotate by revoking the row and inserting a new hash). Generated on Fendi's Mac and
   kept in a private file there; only the SHA-256 is in the database, and the value was never
   in chat. With it, `verify-muse-live.mjs` → **28 pass · 0 fail · 0 skip, MUSE LIVE
   VERIFICATION PASSED**, including section 4 (all 7 resources return data; unknown data
   reported honestly).
2. **Signed-in render of `/muse`** has not been observed by an agent (the published domain
   needs a logged-in session). Deployment is verified; data rendering is not.
3. **Lovable Cloud instance** is Tiny (0.5 GB RAM). Earlier on 2026-09-26 it hit its resource
   ceiling (SQL editor connection timeouts, `select 1` ≈ 20 s). By 22:23 UTC it had recovered
   (`select 1` ≈ 1.8 s, 15 connections, 1 active). Treat as a transient event unless it recurs.

The steps below are kept as the record of how this was done.

## Hard rules (from `CLAUDE.md`)

There is **no standalone Supabase**. This app is Lovable-managed.

* ❌ Do **not** run the `supabase` CLI. A 403 there is a **false wall**, not a real blocker.
* ❌ Do **not** open supabase.com to apply migrations.
* ❌ Do **not** ask Fendi to paste SQL — you have the SQL, you run it.
* ❌ Do **not** hunt for a separate Supabase project outside Lovable Cloud.
* ✅ SQL goes in the **Lovable SQL editor**. Functions go live via **Lovable → Edge Functions → redeploy**. Frontend goes live via **Lovable → Publish**.
* **Publish ≠ edge redeploy.** They are separate buttons. Name which you pressed.

## Coordinates

| | |
|---|---|
| Lovable project id | `7fce9fc6-fd96-4a31-8a89-649f00298c51` |
| Supabase (Lovable Cloud) | `wkzwcfmvnwolgrdpnygc` |
| Repo | `github.com/fendifrost-dot/fendi-control-center` |
| Migration to run | `supabase/migrations/20260925120000_muse_executive_layer.sql` |
| Edge function to redeploy | `muse-executive` |

---

## Step 1 — Apply the schema (Lovable SQL editor)

Open the Lovable project → SQL editor. Paste the **entire contents** of
`supabase/migrations/20260925120000_muse_executive_layer.sql` (read it from the repo at
`main`; it is ~1,200 lines — paste all of it, not an excerpt) and run it.

It is **idempotent**: every `CREATE TABLE` is `IF NOT EXISTS`, every policy is dropped
before being created, and every seed is guarded. Re-running it is safe, so if you are
unsure whether it completed, run it again rather than guessing.

Expect `NOTICE: relation ... already exists, skipping` lines on a re-run. Those are normal.
An **ERROR** is not.

### Step 1a — Verify the schema landed (do not skip)

Run this in the SQL editor:

```sql
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and c.relname like 'muse\_%' and c.relkind='r') as tables,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and c.relname like 'muse\_%' and c.relkind='v') as views,
  (select count(*) from public.muse_domains)          as domains,
  (select count(*) from public.muse_systems)          as systems,
  (select count(*) from public.muse_open_loops)       as open_loops,
  (select count(*) from public.muse_decisions)        as decisions,
  (select count(*) from public.muse_kpi_registry)     as kpis,
  (select count(*) from public.muse_source_authority) as sources;
```

**Expected exactly:** `tables=11, views=11, domains=8, systems=21, open_loops=13, decisions=4, kpis=19, sources=13`.

Anything lower means the paste was truncated — re-paste the whole file.

Then confirm the derived views actually compute against live data:

```sql
select system_key, status, data_status, pending_count, failing_count
from public.muse_system_health order by sort_order;
```

You should see real statuses for the 12 observed systems (`drive-sync`, `ingestion-jobs`,
`statement-chunk-jobs`, `telegram-webhook`, `telegram-outbox`, `guardian-queue`,
`workflow-runner`, `remote-bridge`, `remote-command-queue`, `cc-tool-executor`,
`agent-task-loop`, `approval-queue`) and `NOT_OBSERVED` /
`SOURCE_EXISTS_ACCESS_NEEDED` for the 9 unconnected ones (Boltz, AGH, GitHub, Lovable
deploys, Claude Code, Cursor). `NOT_OBSERVED` on those is **correct** — do not try to
"fix" it.

Whatever statuses come back are the real state of Fendi's systems. If something reads
`FAILING`, that is a genuine finding to report, not a deployment problem.

## Step 2 — Redeploy the edge function — ✅ ALREADY DONE

_Verified live on 2026-09-26: the function responds, rejects unauthenticated reads with 401,
refuses a Supabase key as a Muse token, and returns 405 on all four write verbs. Skip this
step. Kept here for reference only._

**Lovable → Edge Functions → `muse-executive` → redeploy.**

If `muse-executive` is not listed, Lovable has not synced `main` yet — it was merged in
`b576721`. Wait for the sync, or trigger it, then look again. Do not create the function
by hand.

Quick check that it is live (from anywhere):

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/muse-executive/executive/brief
```

* `401` → ✅ deployed and correctly refusing unauthenticated reads.
* `404` → ❌ not deployed yet.

## Step 3 — Publish the frontend — ✅ APPEARS DONE

_Lovable committed "Rebuilt frontend preview" (`2d80a17`) on 2026-09-26. Confirm `/muse`
loads on the Control Hub domain; until Step 1 is done it will correctly show the "Muse schema
is not in this database yet" panel, which is the honest state, not a bug._

**Lovable → Publish.** This exposes `/muse` (Brief, Portfolio, Open loops, 1% ledger,
Sources, Systems) and adds the "Muse" tile to the Hub cover menu.

Then sign in and open `/muse`. If the pages render data, steps 1–3 worked. If they show
*"Muse schema is not in this database yet"*, step 1 did not actually take — go back.

## Step 4 — Optional: the agent-facing API token

Only needed if Muse-as-an-agent should read the API. The UI works without it.

Generate a high-entropy token **outside** the database, then in the SQL editor:

```sql
insert into public.muse_api_tokens (label, token_sha256, scopes, expires_at)
values ('muse-agent', encode(digest('<THE-TOKEN>', 'sha256'), 'hex'),
        array['read'], now() + interval '90 days');
```

Supabase keeps pgcrypto in the `extensions` schema, so if bare `digest(...)` errors with
"function does not exist", use `extensions.digest('<THE-TOKEN>', 'sha256')` instead — or
compute the SHA-256 hex outside the database (`printf '%s' '<THE-TOKEN>' | sha256sum`) and
paste the hex literal.

**Never** paste the token into chat, a commit, or an issue. Only its hash is stored.
Alternatively set `MUSE_API_TOKEN` in Lovable Cloud secrets as a bootstrap credential.

## Step 5 — Run the live verification

From a checkout of `main`:

```bash
MUSE_API_TOKEN=<token> node scripts/muse/verify-muse-live.mjs
```

(The token is optional — without it the read-only checks still run and the data-shape
checks are skipped.)

It checks: schema present, `anon` cannot read any Muse object, unauthenticated reads
rejected, a Supabase key refused as a Muse token, **POST/PUT/PATCH/DELETE all return
405**, unknown resources and injected filters refused, every envelope well-formed, no
credential-shaped value in any payload, and unknown data reported honestly.

**Report its actual output.** Do not summarise it as "passed" unless it prints
`MUSE LIVE VERIFICATION PASSED`.

## Step 6 — Close the loop in Muse's own ledger

Muse tracks its own deployment, so record what is now true. Run **only after step 5
passes** — this is the difference between `CLAIMED` and `LIVE_VERIFIED`, and writing it
early defeats the entire point of the ledger.

```sql
-- Promote only what a live check actually proved.
update public.muse_verifications
   set verification_state = 'LIVE_VERIFIED',
       verified_by = '<who ran the verification>',
       verified_at = now(),
       notes = coalesce(notes, '') || ' Live-verified by scripts/muse/verify-muse-live.mjs.'
 where subject_ref in ('muse-executive', '/muse')
   and verification_state <> 'LIVE_VERIFIED';

update public.muse_verifications
   set verification_state = 'SYSTEM_VERIFIED',
       verified_by = '<who applied it>',
       verified_at = now()
 where subject_ref = '20260925120000_muse_executive_layer.sql';

-- Close the deployment open loop.
update public.muse_open_loops
   set state = 'RESOLVED', resolved_at = now(),
       verification_state = 'LIVE_VERIFIED',
       last_evidence_at = now(),
       next_action = null
 where title = 'Muse v1: apply migration in Lovable SQL editor and redeploy muse-executive';

-- Record that Control Hub runtime truth was verified just now.
update public.muse_source_authority
   set last_verified_at = now()
 where subject in ('Control Hub runtime state', 'Code and schema');
```

If step 5 did **not** pass, leave all of this alone and report what failed instead.

---

## Report back

1. Which Lovable buttons you actually pressed (SQL run / edge redeploy / publish — name them).
2. The counts from step 1a.
3. The `muse_system_health` output — especially anything `FAILING` or `STALE`, which is a real finding about Fendi's systems.
4. The full output of step 5.
5. Whether you ran step 6.

## Do not

* Do not modify the migration to make it run. If it errors, report the error verbatim — the SQL is validated against PostgreSQL 16 and an error means something about the live database differs, which is itself the finding.
* Do not create Muse tables or views by hand.
* Do not grant `anon` access to anything, or widen the edge function beyond GET.
* Do not mark anything `LIVE_VERIFIED` that a live check did not prove.
* Do not "fix" `NOT_OBSERVED` / `SOURCE_EXISTS_ACCESS_NEEDED` rows — they are accurate. Connecting Boltz and AGH is Phase 2 and needs a credential decision from Fendi first.
