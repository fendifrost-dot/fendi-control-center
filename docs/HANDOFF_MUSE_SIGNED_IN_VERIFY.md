# Handoff — verify Muse renders, with a signed-in browser

**For:** a Claude agent with browser tools whose browser is **already signed in** to the
Control Hub. That is the one capability every prior session lacked, and it is the only thing
standing between Muse being *deployed* and being *known to work*.

Rule this serves: [`CLAUDE.md`](../CLAUDE.md) → "Finish every coding session with a handoff
prompt". Deploy record: [`HANDOFF_MUSE_LOVABLE_DEPLOY.md`](./HANDOFF_MUSE_LOVABLE_DEPLOY.md).
Design: [`MUSE_EXECUTIVE_LAYER.md`](./MUSE_EXECUTIVE_LAYER.md).

**This task is read-only.** You are confirming what is true, not changing anything. The only
writes contemplated are in Step 3, and only if it turns out a claim was recorded that isn't.

---

## Status going in

| Thing | State | How it was established |
|---|---|---|
| Code on `main` | ✅ `630fa83` | merged #19–#26 |
| Schema in the live database | ✅ applied | `42501 permission denied for view …` on all 9 views — PostgREST names a relation's kind only for one it resolved |
| `muse-executive` API | ✅ live, read-only | 401 unauthenticated · 401 invalid token · 401 Supabase key refused · **405 on POST/PUT/PATCH/DELETE** |
| `/muse` bundle published | ✅ | `fendi-control-center.lovable.app` serves `index-C2yrT4DR.js`, which contains `/muse`, the five sub-routes, `muse_executive_brief`, `muse_system_health` |
| `verify-muse-live.mjs` | ✅ 17/0/1 anon · 28/0/0 with token | run from the repo |
| Bearer-token path | ✅ fixed in #27 (`365a265`) | `MUSE_API_TOKEN` was compared untrimmed while the presented token was trimmed, so a secret saved with a trailing newline could never match — it logged `unknown token`. If you hit an unexplained 401 with a token you believe is right, check for whitespace first |
| **`/muse` rendering real rows** | ❓ **never observed by anyone** | ← your job |
| **Ledger promoted to `LIVE_VERIFIED`** | ⚠️ **claimed, not independently verified** | recorded by another agent as `verified_by = claude-cowork`; no one has read the rows back |

The second-to-last row is the point of this handoff. Deployment is proven. **Data rendering is
not.** A published bundle proves the code shipped, not that a single row reaches the screen.

The last row matters for a specific reason: Muse's whole premise is that an agent saying
"done" is never completion. A `LIVE_VERIFIED` row that nobody read back is exactly the failure
mode the ledger exists to prevent — so verify it rather than inherit it.

## Coordinates

| | |
|---|---|
| App | `https://fendi-control-center.lovable.app` |
| Muse | `/muse` · `/muse/portfolio` · `/muse/loops` · `/muse/improvements` · `/muse/sources` · `/muse/systems` |
| Sign-in | `/login` — `RequireSession` redirects there if the session lapses |
| Lovable project | `7fce9fc6-fd96-4a31-8a89-649f00298c51` |
| Supabase (Lovable Cloud) | `wkzwcfmvnwolgrdpnygc` |

**If you see the panel "Muse schema is not in this database yet"** — stop and report it. That
would contradict the verified state above and is a real finding, not something to click past.

---

## Step 1 — The six surfaces render

Open each route and record **what you actually see**, not what you expect.

Expected content, derived from the migration's seeds — use these to catch a half-working page:

| Route | Expect |
|---|---|
| `/muse` (brief) | **5 populated sections**: Top priorities, Decisions required, Blockers, System & agent failures, Waiting. **3 deliberately empty**: Material financial issues, Opportunities, Upcoming commitments — each showing "wired and empty because no real item exists yet" |
| `/muse/portfolio` | **8 domain cards**: Boltz Automotive, Modest Streetwear, Fendi Frost / Music, The Workhouse, Nonprofit / Community, Personal Executive Operations, AI / Technical Systems, Tax & Credit Services |
| `/muse/loops` | **13 loops total**; the "open" filter shows fewer. Plus **4 decisions** below with options and evidence |
| `/muse/improvements` | **2 entries**, both `PENDING` verdict |
| `/muse/sources` | **13 source rows** + **1 open conflict** (`pending_route_clarifications`) showing both sides |
| `/muse/systems` | **two tables**: ~12 "Observed by Control Hub", ~9 "Known but not connected" |

Two specific things worth confirming, because they prove logic rather than layout:

1. **`/muse/loops` — derived resolution.** The loop *"Confirm Drive Sync has completed a
   successful run since Muse went live"* should show state **RESOLVED**, a `via drive-sync`
   marker, and an amber **`stored: OPEN`** line. That is the authoritative system closing a
   loop nobody manually updated — the central claim of the open-loop model. If it shows plain
   OPEN, the derivation is not working.
2. **`/muse/portfolio` — no invented numbers.** Boltz, Modest, Workhouse and Nonprofit must
   show **no KPI figure** (an em-dash, not `0`) alongside `source exists access needed` or
   `unknown`. A `0` there would be a bug: it would read as a real measurement.

Screenshot each surface if you can.

## Step 2 — Does the brief agree with the systems page?

The brief's "System & agent failures" section is derived from `muse_system_health`. As of
2026-09-26 22:28 UTC the live read showed **`remote-bridge` STALE** and nothing `FAILING`.

So the brief should list `remote-bridge` under system failures. If the systems page shows
something stale or failing that the brief omits, that is a derivation bug — report it with
both screenshots.

## Step 3 — Read the verification ledger back

Query it (Lovable SQL editor, or any signed-in read):

```sql
select subject_type, subject_ref, verification_state, verified_by, verified_at
from public.muse_verifications
order by subject_ref;

select title, state, stored_state, resolved_at, verification_state
from public.muse_open_loops_live
where title like 'Muse v1%' or derive_resolution_from is not null;
```

Expected, if the earlier agent's record is accurate:

* `muse-executive` → `LIVE_VERIFIED`
* `/muse` → `LIVE_VERIFIED`
* `20260925120000_muse_executive_layer.sql` → `SYSTEM_VERIFIED`
* the "Muse v1: apply migration…" loop → `RESOLVED`

**If any row does not match, say so plainly** — that is a more valuable finding than a clean
pass, because it means the ledger recorded something that wasn't verified.

One correction you may legitimately make: `/muse` is currently marked `LIVE_VERIFIED` on the
strength of the bundle being served, which is *deployment*. Once you have actually seen rows
render, that state is earned. If rows do **not** render, downgrade it:

```sql
update public.muse_verifications
   set verification_state = 'SYSTEM_VERIFIED',
       notes = coalesce(notes, '') || ' Bundle deployed, but a signed-in render showed no data on <date>.'
 where subject_ref = '/muse';
```

## Step 4 — The stale Mac bridge

`remote-bridge` reports **STALE**: last successful heartbeat `2026-06-09T17:30:11Z`, roughly
3.5 months ago, with no failures recorded. Registered cadence is 30 minutes, so Muse flags
anything past 60.

This is Muse's first genuine operational finding, and it is not a Muse bug. Establish which it
is and report:

* The daemon simply is not running on the Mac → expected, and `remote-bridge` will stay STALE
  until it is. Worth telling Fendi, since queued remote commands silently never execute.
* The daemon *is* running but not updating `remote_bridge_devices.last_seen_at` → a real bug
  in the bridge.
* The 30-minute cadence is wrong for how it actually behaves → fix the registry value, not the
  health view:

```sql
update public.muse_systems set cadence_minutes = <real value> where key = 'remote-bridge';
```

Do **not** silence it by clearing the cadence. A system whose staleness cannot be detected is
worse than one reported stale.

While there: `ingestion-jobs` shows **208 pending** with latest activity `2026-04-01`, and
reads `NEVER_RAN / NOT_MEASURED` because no job ever completed cleanly. Confirm whether that
backlog is real and worth Fendi's attention.

---

## Report back

1. Whether each of the six surfaces rendered, with screenshots.
2. Actual counts seen vs the table in Step 1 — call out every mismatch.
3. Whether the Drive Sync loop showed derived `RESOLVED` with `stored: OPEN`.
4. Whether any unconnected domain displayed a number instead of an em-dash.
5. The `muse_verifications` rows exactly as returned, and whether they matched.
6. Your read on `remote-bridge`: daemon down, bridge bug, or wrong cadence.
7. Whether the `ingestion-jobs` backlog is real.

## Do not

* Do not write to any `muse_*` table except the two corrections named in Steps 3 and 4.
* Do not "fix" rows reading `NOT_OBSERVED` or `SOURCE_EXISTS_ACCESS_NEEDED` — those are
  accurate. Connecting Boltz and AGH is Phase 2 and needs a credential decision from Fendi
  first (it is already recorded in the decision register).
* Do not re-run the migration. It is applied and idempotent, but the Lovable Cloud instance is
  Tiny (0.5 GB) and hit its ceiling once on 2026-09-26.
* Do not put the `MUSE_API_TOKEN` value, or any key, in chat, a commit, or an issue.
* Do not mark anything `LIVE_VERIFIED` you did not personally see working.
* Do not treat an empty brief section as a bug — three are empty by design, and the page says so.
