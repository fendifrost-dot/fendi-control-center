# Handoff — Muse nightly stall

The evening hang is real, and it is the database refusing new connections while
authenticated Muse calls wait on `muse_api_tokens.last_used_at`. This handoff
applies the migration and redeploys the four functions. It does not vacuum
`net._http_response`. postgres cannot, and that failure is a finding, not a
step to route around.

---

## Status going in

| Thing | State |
|---|---|
| Code on `main` | ❌ this branch only, until the PR merges |
| Schema in the live database | ❌ `muse_resolve_api_token` and `prune_cron_job_run_details` are not there yet. The cron job is intentionally not created by the migration |
| Edge functions live | ❌ `muse-alerts`, `muse-workboard`, `muse-executive`, `agent-hub` still await `last_used_at` with no timeout |
| Frontend published | not part of this change |
| Validated locally | ✅ `deno test supabase/functions/_shared/museTokenAuth_test.ts` |

Read-only facts already taken from project `wkzwcfmvnwolgrdpnygc` on 2026-11-17,
about 09:30 UTC. Do not treat them as something this handoff re-proved.

| Fact | Value |
|---|---|
| `net._http_response` heap | 421 MB, about 100 live rows, content bytes about 12 KB |
| `last_autovacuum` on that table | 2026-08-05 11:02:51 UTC. `autovacuum_count` was 1. `n_dead_tup` was 0 |
| pg_net | 0.19.5, `pg_net.username = postgres`, ttl 6 hours |
| Expiry delete as `postgres` | 206,076 calls, min 0.01 ms, mean 10.1 s, max 73.5 min |
| `cron.job_run_details` heap | 642 MB. Only index is `job_run_details_pkey` on `runid`. Never autovacuumed |
| `cron.use_background_workers` | off |
| Cron failures | both jobs, `job startup timeout`, only inside about 00:40–05:00 UTC, last failure each night was the 05:00 UTC tick, first night 2026-11-13 01:45 UTC |
| `muse_api_tokens` last_used update | 3,800 calls, mean 48 ms, max 40.7 s |
| Database `statement_timeout` / `lock_timeout` | 120 s / 0 |
| Table owner of `net._http_response` and `cron.job_run_details` | `supabase_admin` |
| Role the Lovable SQL editor uses | `postgres`. Not superuser. Not a member of `supabase_admin` |

A missing bearer returns 401 before any query. That is why anonymous calls stay
fast. The two cron jobs (`dispatch-chunk-jobs`, `drain-guardian-queue`) are
victims: `job startup timeout` means their SQL never started.

## Hard rules

* ❌ No `supabase` CLI. A 403 there is a false wall.
* ❌ No supabase.com dashboard for this migration.
* ❌ Do not print `cron.job.command`. Those rows contain a bearer.
* ❌ Do not `VACUUM`, `CREATE INDEX`, `ALTER TABLE`, or `REASSIGN OWNED` on
  `net._http_response` or `cron.job_run_details` as a workaround. postgres is
  not the owner. The error is the finding.
* ❌ Do not change the migration so a failing statement "succeeds".
* ❌ Do not delete or update `muse_api_tokens`, and do not paste a real token
  or its hash into chat.
* ✅ SQL → Lovable SQL editor, file
  `supabase/migrations/20261117143000_muse_token_touch_and_cron_retention.sql`,
  applied as written.
* ✅ Then Lovable → Edge Functions → redeploy, one function at a time:
  `muse-alerts`, `muse-workboard`, `muse-executive`, `agent-hub`.
* Publish is not part of this. No frontend change.

## Coordinates

| | |
|---|---|
| Lovable project id | `7fce9fc6-fd96-4a31-8a89-649f00298c51` |
| Supabase project | `wkzwcfmvnwolgrdpnygc` |
| Repo | `github.com/fendifrost-dot/fendi-control-center` |
| Migration | `supabase/migrations/20261117143000_muse_token_touch_and_cron_retention.sql` |
| Functions to redeploy | `muse-alerts`, `muse-workboard`, `muse-executive`, `agent-hub` |

Apply the SQL outside 00:40–05:15 UTC. The index-free history delete is
batched, but the editor should not be competing with the stall.

## Step 1 — Apply the migration

Open the Lovable SQL editor on this project and run the migration file in one
pass. It creates `public.muse_resolve_api_token` and
`public.prune_cron_job_run_details`. It does not delete rows and it does not
call `cron.schedule`. postgres can select `cron.job` and cannot insert into it,
so a schedule inside this file would roll the token function back.

### Step 1a — Verify the objects

```sql
select n.nspname, p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname in ('muse_resolve_api_token', 'prune_cron_job_run_details')
order by p.proname;
```

**Expected exactly two rows:**

| nspname | proname |
|---|---|
| public | muse_resolve_api_token |
| public | prune_cron_job_run_details |

Anything else means the migration did not commit. Do not create the functions
by hand.

```sql
select public.muse_resolve_api_token('0000000000000000000000000000000000000000000000000000000000000000');
```

**Expected:** zero rows, and the statement finishes in under 3 seconds. That
hash matches no token, so it must not update `last_used_at`.

## Step 2 — Redeploy the four functions

Lovable → Edge Functions → redeploy, in this order:

1. `muse-alerts`
2. `muse-workboard`
3. `muse-executive`
4. `agent-hub`

Redeploying before the SQL is safe: the functions fall back to a single read
and do not update `last_used_at`. After the SQL, they use the resolver, which
stamps `last_used_at` at most once every 5 minutes and gives up on the row
lock after 250 ms.

### Step 2a — Anonymous calls stay 401

Replace nothing. No bearer.

```bash
curl -sS -m 15 -o /tmp/muse-alerts-anon.json -w 'alerts %{http_code} time %{time_total}\n' \
  'https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/muse-alerts'
curl -sS -m 15 -o /tmp/muse-workboard-anon.json -w 'workboard %{http_code} time %{time_total}\n' \
  -X POST 'https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/muse-workboard' \
  -H 'content-type: application/json' -d '{}'
```

**Expected:** both HTTP `401`, both `time` under 2 seconds, both bodies contain
`"missing token"`. `404` means that function is not deployed. A hang to the 15
second curl limit means the old function is still live.

### Step 2b — A bad bearer fails fast

```bash
curl -sS -m 20 -o /tmp/muse-alerts-bad.json -w 'alerts %{http_code} time %{time_total}\n' \
  -H 'authorization: Bearer not-a-real-muse-token' \
  'https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/muse-alerts'
curl -sS -m 20 -o /tmp/muse-workboard-bad.json -w 'workboard %{http_code} time %{time_total}\n' \
  -X POST -H 'authorization: Bearer not-a-real-muse-token' -H 'content-type: application/json' \
  -d '{"action":"append_update","payload":{}}' \
  'https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/muse-workboard'
```

**Outside 00:40–05:15 UTC, expected:** both HTTP `401`, both bodies contain
`unknown token`, both `time` under 8 seconds. This bearer is not a stored
token, so workboard must not get as far as the scope check.

**Inside 00:40–05:15 UTC, expected:** HTTP `503` within 10 seconds, body
`"error": "database_timeout"`. `curl` exit 28, HTTP `000`, or an empty body
means the timeout wrapper is not the code that is live.

Do not retry with a real Muse token. A wrong token is enough to prove the
lookup no longer hangs.

## Step 3 — Try to schedule retention, and stop if postgres is denied

Run this as its own statement, after Step 1a succeeded. Do not put it back
into the migration.

```sql
select cron.schedule(
  'prune-cron-job-run-details',
  '2,7,12,17,22,27,32,37,42,47,52,57 * * * *',
  $$select public.prune_cron_job_run_details();$$
);
```

**Expected for the Lovable SQL editor:** permission denied on `cron.job`.
postgres has `SELECT` on that table and not `INSERT`. `cron.schedule` is
security invoker. Paste the error. Do not `GRANT INSERT` and do not
`REVOKE` anything to get past it.

If it instead returns a job id, confirm with:

```sql
select jobname, schedule, active
from cron.job
where jobname = 'prune-cron-job-run-details';
```

**Expected in that case only:** one row, schedule
`2,7,12,17,22,27,32,37,42,47,52,57 * * * *`, `active = true`. Then, after one
of those minutes has passed and outside 00:40–05:15 UTC:

```sql
select d.status, d.return_message, d.start_time
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
where j.jobname = 'prune-cron-job-run-details'
order by d.runid desc
limit 3;
```

A succeeded row whose `return_message` is `2000` means one batch of old run
history was deleted. `0` is correct only once the newest 10,000 run ids are
all that remain. Do not call `prune_cron_job_run_details()` yourself in a loop.

## Step 4 — Record the bloat, and stop

```sql
select c.relname,
       pg_size_pretty(pg_relation_size(c.oid)) as heap,
       s.last_vacuum,
       s.last_autovacuum,
       s.n_dead_tup
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_stat_all_tables s on s.relid = c.oid
where n.nspname = 'net' and c.relname = '_http_response';
```

**Expected if nobody has vacuumed:** heap still about 421 MB, `last_vacuum`
null, `last_autovacuum` still 2026-08-05. Report those values. They mean the
extension bloat is unchanged. That is expected. Do not try to fix it in this
pass.

If you run `VACUUM net._http_response` anyway, the expected error is
`must be owner of table _http_response`. Paste that error. Do not grant
ownership to postgres, and do not `ALTER EXTENSION`.

## Report back

1. Whether the migration committed, and the two verification result sets from Step 1a.
2. Which four functions you redeployed, and the four curl lines (status, time, and the `error` / `message` fields only).
3. The verbatim result of the `cron.schedule` statement. Permission denied is a successful finding. A job id is the other success; then include `status` and `return_message` from the follow-up query.
4. The `_http_response` heap size, `last_vacuum`, and `last_autovacuum`.
5. The verbatim error if a vacuum was attempted. Do not retry it a second way.

## Do not

* Do not edit the migration to make it run.
* Do not create the functions or the cron job by hand if the file failed.
* Do not grant `supabase_admin` to postgres, and do not change table owners.
* Do not print cron commands, token hashes, or bearer headers.
* Do not mark the evening stall cleared. Clearing it requires the
  `net._http_response` heap to stop producing multi-second deletes, which this
  pass cannot vacuum. The live proof that callers no longer hang is a `401`
  or a `503` body inside 10 seconds, not a claim that the database is healthy.
