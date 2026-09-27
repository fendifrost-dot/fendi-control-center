# Handoff: make the Muse v2 mission board live

**For:** a Claude agent with browser tools that can reach the Lovable project (SQL editor,
Edge Functions, Publish). Ideally it is already signed in to the Control Hub, for Step 6.

Rule this serves: [`CLAUDE.md`](../CLAUDE.md) → "Finish every coding session with a handoff
prompt". Design: [`MUSE_MISSION_BOARD.md`](./MUSE_MISSION_BOARD.md). v1 deploy record:
[`HANDOFF_MUSE_LOVABLE_DEPLOY.md`](./HANDOFF_MUSE_LOVABLE_DEPLOY.md).

The code is **CODED, not LIVE**. Nothing below has been executed against the live system.

---

## Status going in

| Thing | State | How it was established |
|---|---|---|
| Code | ✅ commit `d4ffa9e` on branch `claude/control-center-mission-board-j4xh9m` | Merge to `main` first if it isn't already. Check with `git log origin/main --oneline \| grep d4ffa9e` |
| Migration validated | ✅ local PostgreSQL 16 | `scripts/muse/verify-muse-sql.sh`: 39 v1 + 64 v2 assertions pass, including re-applying v2 (idempotency) |
| Frontend / API validated | ✅ | `tsc`, `eslint`, `vite build`, Vitest 40/40, Deno contract tests 12/12, `deno check` on `muse-executive` |
| Schema in the live database | ❌ **not applied** | Step 1 |
| `muse-executive` redeployed with the new allowlist | ❌ | Step 3 |
| Frontend published with the new `/muse/*` pages | ❌ | Step 4 |
| Protocol exercised live | ❌ | Step 2 |
| Rendered in a browser | ❌ never observed, locally or live | Step 6 |

## Hard rules

* ❌ No `supabase` CLI. A 403 there is a **false wall**, not a real blocker.
* ❌ No supabase.com dashboard for migrations.
* ❌ Don't ask Fendi to paste SQL. You have the SQL; you run it.
* ✅ SQL goes in the **Lovable SQL editor**. Functions go through **Lovable → Edge Functions →
  redeploy**. The frontend goes through **Lovable → Publish**.
* **Publish ≠ edge redeploy.** They are separate buttons. Name which one you pressed.
* ❌ **Never re-run the v1 migration** (`20260925120000_muse_executive_layer.sql`) after this one.
  It will fail with `cannot drop columns from view`. That is by design. Re-run *this* file if you
  need to; it is idempotent.

## Coordinates

| | |
|---|---|
| Lovable project id | `7fce9fc6-fd96-4a31-8a89-649f00298c51` |
| Supabase (Lovable Cloud) | `wkzwcfmvnwolgrdpnygc` |
| App | `https://fendi-control-center.lovable.app` |
| File to apply | `supabase/migrations/20260927120000_muse_mission_board.sql` (whole file, one pass) |
| Smoke test | `scripts/muse/smoke-muse-board-live.sql` |
| Function to redeploy | `muse-executive` (only this one) |

---

## Step 1: Apply the migration

Paste the **entire** `supabase/migrations/20260927120000_muse_mission_board.sql` into the Lovable
SQL editor and run it once.

`NOTICE: … already exists, skipping` lines are normal. Any `ERROR` is a finding: stop and report
it verbatim (see "Do not").

### Step 1a: Verify it landed (never optional)

```sql
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like 'muse\_%' and c.relkind = 'r') as tables,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like 'muse\_%' and c.relkind = 'v') as views,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('muse_transition_mission','muse_transition_improvement','muse_transition_task','muse_verify')) as write_fns,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname like 'muse\_%' and not t.tgisinternal) as triggers,
  (select count(*) from public.muse_systems where agent_tier is not null) as tiered_agents,
  (select count(*) from public.muse_improvements where status in ('RUNNING','MEASURED')) as legacy_statuses,
  (select string_agg(status || '=' || c, ', ' order by status)
     from (select status, count(*) c from public.muse_improvements group by status) s) as improvement_statuses;
```

**Expected exactly:**

| Column | Value | If different |
|---|---|---|
| `tables` | **15** | 11 means the file did not run. 12–14 means it stopped part-way: find the first `ERROR` |
| `views` | **15** | 11 means the views section did not run |
| `write_fns` | **4** | |
| `triggers` | **21** | 9 v1 touch triggers + 12 v2 triggers |
| `tiered_agents` | **5** | muse, grok-bot, claude-code, cursor-workflows, boltz-grok-agent |
| `legacy_statuses` | **0** | |
| `improvement_statuses` | `MEASURING=1, PROPOSED=1` | Seeds as last observed. Any other mix means someone changed rows since v1. Report it; don't "fix" it |

## Step 2: Exercise the protocol live (rolls itself back)

Paste all of `scripts/muse/smoke-muse-board-live.sql` into the Lovable SQL editor and run it.

**Expected: an ERROR.** That is the success signal, because the script aborts itself so nothing
persists. The message must start with:

```
MUSE_BOARD_SMOKE_OK — full protocol ran (… 12 history events). Rolled back; nothing was kept.
```

* `MUSE_BOARD_SMOKE_FAIL: …` means the live database behaves differently from the harness. Report
  it verbatim.
* Any other error, such as `permission denied` or `function … does not exist`, means Step 1 did
  not fully land.

Confirm nothing leaked:

```sql
select count(*) as leaked from public.muse_improvements where intervention like '__smoke%';
```

**Expected exactly:** `leaked=0`.

## Step 3: Redeploy `muse-executive`

**Lovable → Edge Functions → redeploy `muse-executive`.** Publish does not do this.

To distinguish old code from new code (needs `MUSE_API_TOKEN`; never print it):

```bash
URL=https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/muse-executive
curl -s -o /dev/null -w '%{http_code}\n' "$URL/executive/agent-queue"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $MUSE_API_TOKEN" "$URL/executive/agent-queue"
```

* The first returns `401`: deployed and refusing anonymous reads. This is the same before and
  after the redeploy.
* The second returns `200`: ✅ new allowlist is live.
* The second returns `404` with `unknown_resource`: ❌ old code still deployed. Redeploy again.

## Step 4: Publish the frontend

**Lovable → Publish.** Then check that the served bundle contains the new pages:

```bash
APP=https://fendi-control-center.lovable.app
JS=$(curl -s "$APP/" | grep -o '/assets/index-[^"]*\.js' | head -1)
curl -s "$APP$JS" | grep -o 'muse_agent_queue\|muse_mission_board\|muse_verification_queue\|muse_impact_ledger' | sort -u
```

**Expected exactly 4 lines.** 0 lines means Publish did not pick up the commit: check that it is
on `main`.

## Step 5: Run the live verifier

```bash
MUSE_API_TOKEN=<token> node scripts/muse/verify-muse-live.mjs
```

**Expected:** `passed 40 · failed 0 · skipped 0`, then `MUSE LIVE VERIFICATION PASSED`. The 40 is
28 from v1 plus 4 new views, 4 anon RPC refusals and 4 new resources. This number was derived,
not observed. If the pass count differs but failures are 0, report the actual count. Anything
`FAIL` is a finding. In particular, `anon cannot call muse_…` failing with HTTP 200 is a
**security failure**: stop and report.

## Step 6: See it render (signed-in browser)

Open each route and record what you actually see:

| Route | Expect |
|---|---|
| `/muse/missions` | Empty state: "No missions recorded…". None are seeded, by design |
| `/muse/daily` | "No daily outcome recorded for today yet". **Active experiments** lists the v1 "Muse executive layer…" row (status MEASURING). Rotation reads "Less than 30 days of daily-board history" |
| `/muse/queue` | "Nothing assigned…" |
| `/muse/verification` | PENDING ≥ 2, the two v2 rows claimed by `claude-code` |
| `/muse/improvements` | Title **Impact ledger**. One card (the v1 row now MEASURING) plus 2 rows under "All improvements" |
| `/muse` | Loads. The nav wraps to show all 10 tabs |

If you see **"Muse schema is not in this database yet"**, Step 1 did not land. Stop.

## Final step: Record what is now true

Only after Steps 1a–5 match. Record from real output, never from this document:

```sql
update public.muse_verifications
   set verification_state = 'LIVE_VERIFIED',
       verified_by = '<your agent name, not claude-code>',
       verified_at = now(),
       live_evidence = '<paste: Step 1a row, Step 2 OK message, Step 5 summary line>'
 where subject_type in ('migration','ui_module')
   and subject_ref in ('20260927120000_muse_mission_board.sql', '/muse (mission board v2)');
-- Expected: UPDATE 2. Only mark the ui_module row if Step 6 was actually observed; otherwise
-- restrict the WHERE clause to the migration row (UPDATE 1).

update public.muse_open_loops
   set state = 'RESOLVED', resolved_at = now(), last_evidence_at = now(),
       verification_state = 'LIVE_VERIFIED'
 where title like 'Mission board v2:%';
-- Expected: UPDATE 1
```

---

## Report back

1. Which buttons you pressed: SQL editor run(s), **Edge Functions → redeploy `muse-executive`**,
   **Publish**. Name each one.
2. The Step 1a row, verbatim.
3. The Step 2 message, verbatim, and `leaked`.
4. The two HTTP codes from Step 3, and the grep lines from Step 4.
5. The Step 5 summary line, plus any FAIL lines.
6. What each Step 6 route showed, with screenshots if possible.
7. Whether you ran the final recording step, and the `UPDATE n` counts.

## Do not

* **Do not edit the migration or the smoke test to make them run.** If either errors, the live
  database differs from what was validated, and **that is the finding**.
* Do not re-run the v1 migration.
* Do not hand-create any object the migration creates.
* Do not create real missions or improvements to "test the UI". The board records business
  decisions, which are Muse's or Fendi's to make. The smoke test covers the protocol and leaves
  nothing behind.
* Do not grant `anon` anything or loosen a policy to get past an error.
* Do not wire Grok or add write tools to `telegram-webhook` as part of this handoff. That is a
  separate change (design §7/§8) with its own redeploy.
* Do not mark anything verified that a live check didn't prove. Don't record verification as
  `claude-code`: the claimant cannot verify its own claim.

## What remains after this handoff (not for this agent)

These are known, designed and deliberately not built. See `MUSE_MISSION_BOARD.md`.

1. **The Grok Chief-of-Staff runtime is not wired.** Decide which runtime hosts it, then add the
   five board calls as tools in `telegram-webhook` (§7).
2. **There is no executor write path for cloud Claude sessions.** Claude can read its queue but
   cannot report state itself (§8).
3. **Actor identity is declared, not authenticated.** Per-agent credentials close this (§12).
