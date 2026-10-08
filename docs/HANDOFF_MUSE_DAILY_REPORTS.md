# Handoff — Daily reports home and work-feed parent filters

Code is on the branch. Nothing in this file has been applied to the live project.
Do not treat a green local test as `LIVE`.

## Status going in

| Thing | State |
|---|---|
| Code | On branch `cursor/muse-daily-reports-feed-filters-986c`. Not merged. Not deployed. |
| Schema in the live database | Not applied. `muse_daily_reports` does not exist yet. |
| `muse-executive` live | Old contract. Work feed filters are `domain`, `actor`, `type` only. `daily-reports` is an unknown resource. |
| `muse-workboard` live | Old action list. `record_daily_report` is rejected as `unknown_action`. |
| Frontend published | Not published. `/muse/feed` and `/muse/reports` are not on the live site. |
| Validated locally | Contract tests and page tests in this repo. Not validated against the live database. |

## Hard rules

* No `supabase` CLI. A 403 there is a false wall.
* No supabase.com dashboard for migrations.
* Do not ask Fendi to paste SQL.
* SQL goes in the Lovable SQL editor for project `7fce9fc6-fd96-4a31-8a89-649f00298c51`.
* Edge functions go through Lovable → Edge Functions → redeploy. Name the function.
* Frontend goes through Lovable → Publish.
* Publish is not an edge redeploy.
* Do not merge this PR as part of the deploy. Merge is a separate decision.
* Do not edit the migration to make it run. If it errors, stop and report the error.
* Do not delete, close, or re-parent mission `6f14b53d-4c16-49ec-a475-a1bf94229499`.

## Coordinates

| | |
|---|---|
| Lovable project id | `7fce9fc6-fd96-4a31-8a89-649f00298c51` |
| Supabase project | `wkzwcfmvnwolgrdpnygc` |
| Repo | `github.com/fendifrost-dot/fendi-control-center` |
| Migration | `supabase/migrations/20261008150000_muse_daily_reports.sql` |
| Functions to redeploy | `muse-executive`, then `muse-workboard` |
| Frontend | Publish after the migration, so `/muse/reports` is not an empty missing-schema error on first open |

## Paths after this is live

| | |
|---|---|
| Signed-in work feed | `/muse/feed` |
| Signed-in reports | `/muse/reports` |
| Read feed | `GET /functions/v1/muse-executive/executive/work-feed` |
| Read reports | `GET /functions/v1/muse-executive/executive/daily-reports` |
| Write a report | `POST /functions/v1/muse-workboard` action `record_daily_report` |
| Table | `public.muse_daily_reports` |
| View | `public.muse_daily_report_board` |

Work-feed query params added: `task_id`, `improvement_id`, `mission_id`. Existing params stay: `domain`, `actor`, `type`.

Report query params: `actor`, `cadence` (`START_OF_DAY` or `END_OF_DAY`), `report_date` (`YYYY-MM-DD`).

The stand-in mission stays. Its id is `6f14b53d-4c16-49ec-a475-a1bf94229499`, title `Daily operations reporting to Enki (Grok Bot)`. Reports already written there stay on the work feed. After the functions are redeployed, read them with `mission_id`, not by scanning. New weekday reports use `record_daily_report` and do not pass that mission id.

## Step 1 — Apply the migration

Run the full file `supabase/migrations/20261008150000_muse_daily_reports.sql` in the Lovable SQL editor. One shot. Do not create the table by hand first.

### Step 1a — Verify it landed

```sql
select
  to_regclass('public.muse_daily_reports') is not null as table_ok,
  to_regclass('public.muse_daily_report_board') is not null as view_ok,
  position('record_daily_report' in pg_get_constraintdef(oid)) > 0 as action_ok
from pg_constraint
where conname = 'muse_workboard_requests_action_check';
```

**Expected exactly one row:** `table_ok` true, `view_ok` true, `action_ok` true.

If `action_ok` is false, the audit check was not replaced. Do not call `record_daily_report` until it is true. A write would insert a report and then fail the audit row.

```sql
select count(*) as stand_in
from public.muse_missions
where id = '6f14b53d-4c16-49ec-a475-a1bf94229499';
```

**Expected exactly:** `stand_in=1`. Zero means this migration was not the thing that ran, or something else deleted the mission. Stop.

```sql
select id
from public.muse_work_updates
where id in (
  '2b82bb4b-ac08-4cd0-93ab-6d50c0594010',
  '40d1dc29-ad09-45e2-8e8c-a7871f54eb93'
)
order by id;
```

**Expected both ids.** Those are the first-run note and the 2026-10-08 start-of-day report. If an end-of-day row was added on the stand-in before this migration, leave it. Do not move it.

Then run `scripts/muse/verify-daily-improvement-engine.sql` in the same editor.

**Expected:** the script finishes with `Daily Improvement Engine schema checks passed.`

## Step 2 — Redeploy `muse-executive`

Redeploy only `muse-executive`. Do not publish the frontend yet.

Base: `https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1`

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "$B/muse-executive/executive/daily-reports"
```

* `401` → the function is up and still refusing anonymous reads. This does **not** prove the new resource is deployed. Auth runs before the resource lookup.
* `404` from the platform (function missing) is a different failure. Read the body.

With a read token (do not print the token):

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$B/muse-executive/executive" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); feed=next(r for r in d["resources"] if r["path"]=="/executive/work-feed"); reports=next(r for r in d["resources"] if r["path"]=="/executive/daily-reports"); print(sorted(feed["filters"])); print(sorted(reports["filters"]))'
```

**Expected:**

```text
['actor', 'domain', 'improvement_id', 'mission_id', 'task_id', 'type']
['actor', 'cadence', 'report_date']
```

If `daily-reports` raises `StopIteration`, the redeploy did not pick up this contract. `404` with `unknown_resource` on `GET .../daily-reports` (with the token) means the same thing.

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  "$B/muse-executive/executive/daily-reports"
```

**Expected:** `200`. Body `resource` is `daily-reports`. `row_count` is `0` and `status` is `NOT_MEASURED` until a report is written. Zero rows is not a failed deploy.

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$B/muse-executive/executive/work-feed?mission_id=6f14b53d-4c16-49ec-a475-a1bf94229499&type=STATUS"
```

**Expected:** `200`, and `row_count` at least `2` (the first-run note and the 2026-10-08 start-of-day). A later end-of-day on that mission raises the count. `row_count` `0` means the filter did not deploy or the id was mistyped.

## Step 3 — Redeploy `muse-workboard`

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/muse-workboard" \
  -H 'Content-Type: application/json' \
  -d '{"action":"record_daily_report","payload":{}}'
```

* `401` → deployed, anonymous write refused.
* `400` with `unknown_action` from an authenticated write token → not redeployed.
* `405` on GET → method guard still holds.

Do not send a real report from this handoff. The first real row should be Grok Bot's next start-of-day or end-of-day, with its own idempotency key:

`grok-bot-sod-YYYY-MM-DD` or `grok-bot-eod-YYYY-MM-DD`.

Payload shape:

```json
{
  "action": "record_daily_report",
  "payload": {
    "report_date": "YYYY-MM-DD",
    "cadence": "START_OF_DAY",
    "message": "..."
  }
}
```

End of day sets `cadence` to `END_OF_DAY` and may include `sections` with only these keys: `execution`, `business_activity`, `daily_improvement`, `system_health`, `blockers_decisions`, `spend_commitments`, `next_day`.

After that write, the read in step 2 with `actor`, `cadence`, and `report_date` returns `row_count` `1` for that filing. The actor on the row is the token label (`grok-bot` or `enki`), not a field in the payload.

## Step 4 — Publish the frontend

Publish. Then sign in and open `/muse/feed` and `/muse/reports`.

* `/muse/feed` lists work updates. Pasting a full task id or improvement id leaves only rows with that id. Pasting `6f14b53d-4c16-49ec-a475-a1bf94229499` into mission id shows the stand-in reports.
* `/muse/reports` says no daily reports yet, until step 3's first real filing. It must not say the Muse schema is missing. That sentence means the view is not in the database the published app is reading.

## Report back

1. Whether step 1a returned `table_ok` / `view_ok` / `action_ok` all true, and `stand_in=1`.
2. The two filter lines from the executive index.
3. HTTP status of anonymous `GET daily-reports` and authenticated `GET daily-reports`.
4. `row_count` of the stand-in mission filter.
5. What `/muse/feed` and `/muse/reports` showed after publish.
6. Do not paste tokens.

## Do not

* Do not mark this verified from the PR or from local tests.
* Do not drop the stand-in mission to "clean up".
* Do not copy the old STATUS rows into `muse_daily_reports`. They already have a home on the feed.
* Do not give `workboard:write` to the bootstrap secret.
* Do not edit the migration if step 1 errors.
