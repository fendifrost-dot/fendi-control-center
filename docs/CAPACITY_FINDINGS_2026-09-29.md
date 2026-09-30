# Control Center database — capacity findings, 2026-09-29/30

Read-only investigation after the PostgREST outage. No maintenance was run, no
settings changed beyond the owner-approved `authenticator` timeout (8s → 60s).

## Observed latency (post-recovery, ~1 h after the schema reload finished)

Single-row REST reads of `telegram_outbox` (1,201 rows, 1.1 MB), sampled
00:37–00:44 UTC: **9.0 / 11.9 / 11.6 / 3.1 / 44.5 / 21.6 / 13.8 / 10.4 s**, plus a
60.7 s outlier. A healthy Postgres answers this in milliseconds. Lovable's SQL editor
lost its connection (`Connection terminated due to connection timeout` / `Server
error`) 4× during read-only diagnostics. Lovable's own UI entered a reload loop.

**This is not schema-reload cost. The reload completed at 23:35 UTC.**

## Storage — not the problem

| Metric | Value |
|---|---|
| Database size | 1,077 MB |
| Largest table (total incl. indexes) | `telegram_outbox` 1,128 kB; `tasks` 752 kB; `credit_knowledge_base` 728 kB |
| Dead tuples, worst | `drive_sync_events` 144/736; `tasks` 119/416; `telegram_outbox` 65/1201 |
| Tables >100 rows never vacuumed | 1 |
| Autovacuum workers active at sample | 0 |

Bloat is negligible; the biggest table is ~1 MB. The 1 GB database size is
overwhelmingly *not* in `public` user tables (sum of top-6 ≈ 4 MB) — it sits in
system/extension schemas or storage, which the SQL editor could not enumerate
before losing its connection. **Follow-up:** `select nspname, pg_size_pretty(sum(pg_total_relation_size(c.oid))) from pg_class c join pg_namespace n on n.oid=c.relnamespace group by 1 order by 2 desc;`

## Query hotspots — this is where the IO goes

`pg_stat_user_tables` since stats reset 2025-12-08:

| Table | rows | seq scans | idx scans |
|---|---|---|---|
| `remote_bridge_devices` | 2 | **306,961** | 66 |
| `statement_chunk_jobs` | 2 | **222,822** | 41 |
| `documents` | — | 1,149 | 3,638 |
| `clients` | — | 702 | 3,199 |

**530k full-table scans on two 2-row tables.** Each scan is cheap in isolation, but
this is polling: something reads these tables continuously. Neither has a scheduled
job in the repo's migrations, so the poller is either a `pg_cron` job defined directly
in the live database (not in git) or an edge function on a tight loop. At sample time
two `postgres`-role sessions were active running `net.http_post(...)` — outbound HTTP
issued *from inside the database* via `pg_net`, i.e. a cron-driven job that is not in
the repository. Both were waiting on `LWLock`.

**Follow-up (blocked by connection loss):**
`select jobid, jobname, schedule, active, left(command,120) from cron.job;` and the
last hour of `cron.job_run_details`.

## Schema reload cost (the outage mechanism)

PostgREST's schema-cache load runs `SELECT name FROM pg_timezone_names` (reads ~1,200
zoneinfo files from disk) and a large catalog introspection. Measured: **25.4 s** for the
timezone query alone; observed at 43 s once. Against `authenticator`'s previous 8 s
`statement_timeout` it could never complete → 37 min outage. It is expensive *because
the disk is slow*, not because the schema is large: the Sept-29 migrations added 17
objects (4 tables, 8 views, 5 indexes) to a database that already had ~49 tables/20
views. That is not unusual complexity.

## Muse read cost (secondary)

`muse_system_health` aggregates **22 telemetry tables in full** on every read (only
`failing_count` is time-bounded). It is joined by `muse_open_loops_live`,
`muse_executive_brief` (8 references) and the loop-resolution logic, so one brief read
re-runs all 22 aggregates. Measured: `systems` 1.5 s, `brief` 47.6 s. On a healthy
disk this is fine at current row counts; on this one it is why the brief page times out
first. Fixable later with a materialized health snapshot refreshed on a schedule — not
urgent, and not the cause of the outage.

## Disk pressure frequency (Lovable telemetry)

Lovable's 24 h disk graph flagged pressure in **7 of 24 hours**; CPU and memory never
flagged. Hours that coincide with our work: 11–12 (migration), 15–16, 19–20 (46-function
redeploy), 22–23 (Muse migrations). Several flagged hours had no deployment activity.

## Classification

**D — MIXED**, leaning toward an optimization issue that a Tiny instance cannot
absorb:

* A constant polling workload (≥530k scans on two tiny tables, plus `pg_net` posts from
  a database-side job not in git) generates steady IO the instance has no headroom for.
* The instance's disk is slow enough that a *routine* PostgREST schema reload cannot
  finish in 8 s, and single-row reads take 3–60 s an hour after the reload ended.
* Data volume and bloat are ruled out.

Not **C** (schema-reload-specific): normal reads are degraded outside reload windows.
Not purely **A**: the poller is avoidable load and has not been identified yet.

## Upgrade threshold

* Frequency: 7/24 h flagged; latency degraded continuously during the observation window.
* Normal user operations affected: **yes** — every REST read, so every Control Center screen.
* Failures outside schema events: **yes** — SQL editor connection loss 4×, REST reads
  up to 60 s, an hour after the reload.
* Would optimization likely solve it: **partly.** Finding and throttling the poller is the
  cheapest and should be done first. It may or may not be sufficient; the timezone-file
  read at 25 s is a pure disk-speed measurement unaffected by the poller.
* Benefit of a larger instance: faster disk directly shortens the schema reload and every
  read; it would also let `authenticator` return to 8 s.

**Recommendation: optimize first (identify the `pg_cron`/pg_net job and the
`remote_bridge_devices` / `statement_chunk_jobs` poller; disable or throttle it), then
re-measure the same REST probe. If single-row reads are still >1 s after that, Tiny is
operationally insufficient and an upgrade is justified on evidence. Keep the 60 s
authenticator timeout until then.**
