# Handoff — reclaim net._http_response

The evening stall is the pg_net worker deleting from a 421 MB heap. postgres
can `TRUNCATE` that table. It cannot `VACUUM` it, and it cannot upgrade
pg_net. This handoff runs the truncate, then schedules it daily.

A rolled-back `TRUNCATE` on 2026-11-17 returned `heap=0 bytes`. After the
rollback the live table was still 421 MB, total 430 MB, 118 rows. Use those
as the before numbers.

## Status going in

| Thing | State |
|---|---|
| Code on `main` | ❌ these two migrations are on this branch until the PR merges |
| `muse_resolve_api_token` and the four Muse functions | ✅ live from PR #82. Do not redeploy them |
| `prune-cron-job-run-details` | ✅ job id 5, active |
| `net._http_response` | ❌ 421 MB heap, last autovacuum 2026-08-05 |
| Frontend published | not part of this change |

## Hard rules

* ❌ No `supabase` CLI. A 403 there is a false wall.
* ❌ No supabase.com dashboard for this SQL.
* ❌ Do not `VACUUM`, `VACUUM FULL`, or `REINDEX` `net._http_response`.
  postgres is not the owner. `must be owner of table _http_response` is the
  finding, not a prompt to change ownership.
* ❌ Do not `ALTER EXTENSION pg_net UPDATE`. The newest version installed on
  this host is 0.19.5, and it is already the installed one. 0.20.3 is the
  release that flushes worker stats. It is not in
  `pg_available_extension_versions`.
* ❌ Do not `GRANT` anything, and do not `ALTER DATABASE ... SET pg_net.ttl`.
  A shorter ttl does not shrink the heap, and it makes the worker delete
  harder against the bloated index.
* ❌ Do not change `dispatch-chunk-jobs` or `drain-guardian-queue`. They are
  the only `net.http_post` callers. Neither reads the response. Slowing them
  delays statement chunks and the guardian queue.
* ❌ Do not print `cron.job.command` for jobs 2 or 3. Those commands contain
  a bearer.
* ✅ Lovable SQL editor. Run the two files below, in order, outside
  00:40–05:15 UTC.

## Coordinates

| | |
|---|---|
| Lovable project id | `7fce9fc6-fd96-4a31-8a89-649f00298c51` |
| Supabase project | `wkzwcfmvnwolgrdpnygc` |
| File 1 | `supabase/migrations/20261117170000_truncate_pg_net_responses.sql` |
| File 2 | `supabase/migrations/20261117170100_schedule_pg_net_response_truncate.sql` |

## Step 1 — Truncate the response heap

Run file 1 as one script. It creates `public.truncate_pg_net_responses()` and
calls it. The function sets `lock_timeout` to 5 seconds, truncates
`net._http_response`, and returns the new heap size in bytes. It does not
touch `net.http_request_queue`.

### Step 1a — The call returns 0

The script's last statement is `SELECT public.truncate_pg_net_responses();`.

**Expected exactly:** one row, value `0`.

If the error is `canceling statement due to lock timeout`, the pg_net worker
holds the table. Wait one minute and run file 1 again, once. A second lock
timeout stops this handoff. Paste the error. Do not edit the 5 second limit.

Any other error stops this handoff. Paste it. Do not create the function by
hand and do not issue a bare `TRUNCATE` outside the function.

### Step 1b — The heap is gone

```sql
select pg_relation_size('net._http_response') as heap_bytes,
       pg_total_relation_size('net._http_response') as total_bytes,
       (select count(*) from net._http_response) as live_rows,
       pg_relation_size('net.http_request_queue') as queue_bytes;
```

**Expected:**

| column | value |
|---|---|
| `heap_bytes` | `0` |
| `total_bytes` | under `1048576` |
| `live_rows` | under `30` |
| `queue_bytes` | under `65536` |

`heap_bytes` above `100000000` means the truncate did not commit. Stop.
`queue_bytes` near its old size (about 8 KB) is correct. A few live rows are
the next cron post landing after the truncate.

## Step 2 — Schedule the daily truncate

Run file 2 only after Step 1b matches. It replaces any existing job named
`truncate-pg-net-responses` and schedules `0 15 * * *` (15:00 UTC, 9:00 AM
America/Chicago), which is outside the stall.

### Step 2a — The job exists

```sql
select jobid, jobname, schedule, active, username
from cron.job
where jobname = 'truncate-pg-net-responses';
```

**Expected exactly one row:** `schedule = 0 15 * * *`, `active = true`,
`username = postgres`. The `jobid` is new. It is not 2, 3, or 5.

If file 2 returns permission denied on `cron.job`, paste that error and stop.
Do not grant insert or delete on `cron.job`. File 1 has already reclaimed the
heap. The stall for tonight is addressed. Regrowth is then a later decision.
Job 5 was created from this same editor, so permission denied is not the
expected result.

Do not wait for 15:00 UTC to call this handoff done. The reclaim is Step 1b.
The schedule is what keeps the heap from returning.

## What still needs Supabase, and is not this pass

`pg_net` 0.20.3 (2026-05-19) flushes worker stats so autovacuum can see
`net._http_response`. This project does not have that binary. A superuser
on this host cannot `ALTER EXTENSION` to a version that is not installed.
The platform image has to ship `pg_net` >= 0.20.3. Until then the daily
truncate is the control postgres has. Do not open that as a change to this
migration.

## Report back

1. The return value of `truncate_pg_net_responses()`.
2. `heap_bytes`, `total_bytes`, `live_rows`, and `queue_bytes` from Step 1b.
3. The new job's `jobid`, `schedule`, `active`, and `username`, or the
   verbatim schedule error.
4. Whether either file was run a second time because of a lock timeout.

## Do not

* Do not edit either migration to make it run.
* Do not mark the evening window cleared from the heap size alone. Step 1b
  proves the heap was reclaimed. The next evening is the live check, and it
  is not part of this handoff.
* Do not truncate `net.http_request_queue`.
* Do not redeploy edge functions. None of them changed.
