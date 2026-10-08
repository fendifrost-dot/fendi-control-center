# HANDOFF — Apply the Telegram DORMANT migration live

Status at hand-off (2026-09-29, session_0147BA6wi3pEHYWfWU5vWpvE):

| Item | State | Evidence |
|------|-------|----------|
| Migration `supabase/migrations/20260930000000_muse_telegram_dormant.sql` | **CODED** on `main` (PR #36, merge `2f95745`) | local PG16 clone: brief loses both Telegram items, health 21 → 18 rows, second run no-op, verifier passes |
| Applied to Lovable Cloud (`wkzwcfmvnwolgrdpnygc`) | **UNKNOWN** | one attempt via Lovable SQL editor → `Connection terminated due to connection timeout`; the follow-up read probe was interrupted when the Lovable session signed out |
| Lovable session in Chrome | signed out | tab redirected to `lovable.dev/login` — an agent cannot sign in |

Nothing else is pending from the Telegram reclassification. Capacity findings are already on `main` (`docs/CAPACITY_FINDINGS_2026-09-29.md`).

## Step 1 — probe (read-only) before re-running

In **Lovable → Cloud → SQL editor** on this project:

```sql
select key as k, is_active as active, left(notes,30) as n
  from public.muse_systems
 where key in ('telegram-webhook','telegram-outbox','approval-queue')
union all
select 'loop:'||state, priority ilike 'P3', left(notes,30)
  from public.muse_open_loops
 where title like 'Resolve the pending_route%';
```

Exactly **4 rows**. Interpret:

| Result | Meaning | Do |
|--------|---------|----|
| 3 rows `active = false`, notes start `DORMANT / OPTIONAL TRANSPORT`, loop row `loop:CANCELLED`, `true` | first attempt did apply | skip Step 2, go to Step 3 |
| 3 rows `active = true`, loop `loop:OPEN` | nothing applied | Step 2 |
| mixed | the two UPDATEs ran outside one transaction and the first timed out mid-way | Step 2 anyway — the migration is idempotent and guarded per statement |

## Step 2 — apply

Paste the full contents of `supabase/migrations/20260930000000_muse_telegram_dormant.sql` (as on `main`, unchanged) and Run. Lovable shows **Confirm destructive operation** because the text contains `UPDATE` — choose **Run anyway**.

Expected output: two statements, `UPDATE 3` then `UPDATE 1` (or `UPDATE 0` / `UPDATE 0` if Step 1 showed it already applied). Anything else — including a timeout — means re-run Step 1, not "assume done".

Do **not** edit the migration to make it run. If it errors on something other than a connection timeout, the live schema differs from `main` and that is the finding to report.

## Step 3 — verify the executive surface

```sql
select 'health_rows', count(*)::text from public.muse_system_health
union all
select 'telegram_in_health', count(*)::text from public.muse_system_health
 where system_key in ('telegram-webhook','telegram-outbox','approval-queue')
union all
select 'telegram_in_brief', count(*)::text from public.muse_executive_brief
 where title ilike '%telegram%' or title ilike '%approval queue%' or title ilike '%route_clarifications%';
```

Expected: `telegram_in_health = 0`, `telegram_in_brief = 0`, `health_rows` = (previous count − 3; the local clone went 21 → 18).

No edge function redeploy and no Publish are needed: only table rows changed, and every consumer reads the views live.

## Report back

- Step 1 result (4 rows, verbatim).
- Step 2 output (`UPDATE n` lines, verbatim) or the exact error.
- Step 3 three numbers.

Only after Step 3 matches may this be called LIVE_VERIFIED.
