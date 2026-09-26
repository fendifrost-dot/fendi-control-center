# Handoff — deploy the Muse executive layer in Lovable

**For:** a Claude agent with browser tools (or Fendi, clicking through it manually).
**Goal:** take Muse from `CLAIMED` to `LIVE_VERIFIED`. The code is already merged to `main`;
nothing in this handoff writes code.

Design reference: [`docs/MUSE_EXECUTIVE_LAYER.md`](./MUSE_EXECUTIVE_LAYER.md).

---

## Status going in

**Updated 2026-09-26 after a live re-check. Step 2 is already DONE — do not redo it.**

| Thing | State |
|---|---|
| Code on `main` | ✅ merged (#19 `b576721`, #20 `655702a`, #21 `8c20290`, #22 `53b41ad`) |
| **Schema in the live database** | ❌ **NOT APPLIED — this is the one remaining blocker** |
| `muse-executive` edge function live | ✅ **deployed and live-verified** (see below) |
| `/muse` UI published | ✅ Lovable pushed "Rebuilt frontend preview" (`2d80a17`) |
| Schema validated | ✅ against real PostgreSQL 16, incl. read-only security tests |
| CI on `main` | ✅ green (`2d80a17`, `53b41ad`, `8c20290`) |

### Already live-verified against the deployed function

`scripts/muse/verify-muse-live.mjs` now passes 8 checks against the real endpoint. These are
proven in production and need no re-testing:

| Check | Result |
|---|---|
| Unauthenticated read | ✅ HTTP 401 |
| Invalid token | ✅ HTTP 401 |
| Supabase key presented as a Muse token | ✅ HTTP 401 — refused |
| `POST` / `PUT` / `PATCH` / `DELETE` | ✅ HTTP 405 on all four — read-only enforced |
| `anon` direct write to `muse_open_loops` | ✅ rejected |

So the **read-only guarantee is now LIVE_VERIFIED**, not merely claimed. What is *not* yet
verifiable is anything that needs the tables to exist: the 9 `muse_*` views all report
"not found — migration not applied", so `/muse` will render the "Muse schema is not in this
database yet" panel and API reads will fail rather than return data.

**Therefore: do only Step 1 below, then Step 1a, then Step 5 and Step 6.** Steps 2 and 3 are
done.

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
