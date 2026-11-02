# Handoff — muse-executive rejects a truncated UUID with 400

A truncated `mission_id` (`6f14b53d` instead of the 36-character id) made Postgres
raise `invalid input syntax for type uuid` (`22P02`). `muse-executive` turned every
read error into HTTP 503 `"The executive view could not be read."`, so the board
looked down. This change validates uuid filters before the query.

## Status going in

| Thing | State |
|---|---|
| Code on `main` | ❌ not merged. Branch `cursor/muse-executive-uuid-filter-6678`. |
| Schema in the live database | ✅ no migration. Do not run SQL. |
| Edge function `muse-executive` | ❌ not redeployed. A truncated id on the live function is still a 503. |
| Frontend published | not part of this change. Do not Publish. |
| Production data | ✅ not touched. Do not insert, update, or delete rows. |
| Validated locally | ✅ `deno test supabase/functions/muse-executive/contract.test.ts --allow-env` — 20 passed, 0 failed. `deno check` of `supabase/functions/muse-executive/index.ts` and `contract.ts` passed. Not checked against the live function. |

| | |
|---|---|
| Code commit | `46068ca904bea3024b20abcf0f7e38fa8dda3d20` |

## Hard rules

* ❌ No `supabase` CLI. A 403 there is a false wall.
* ❌ No SQL, in the Lovable SQL editor or anywhere else. This change has no migration.
* ❌ Do not touch production rows. The checks below are GET only.
* ❌ Do not redeploy `muse-workboard`, `agent-hub`, or any function other than `muse-executive`.
* ❌ Do not Publish. There is no frontend change.
* ❌ Do not redeploy until this commit is on `origin/main`. Redeploying earlier ships the old function again.
* ❌ Do not edit the function inside Lovable to recreate the check. If the file Lovable would deploy does not contain `filterValueRejection`, stop and report that.
* ❌ An unauthenticated `401` does not mean the new code is live. The old function also returns 401 with no token.

## Coordinates

| | |
|---|---|
| Lovable project id | `7fce9fc6-fd96-4a31-8a89-649f00298c51` |
| Supabase project | `wkzwcfmvnwolgrdpnygc` |
| Repo | `github.com/fendifrost-dot/fendi-control-center` |
| Files | `supabase/functions/muse-executive/index.ts`, `supabase/functions/muse-executive/contract.ts`, `supabase/functions/muse-executive/contract.test.ts` |
| Function to redeploy | `muse-executive` only, after the commit is on `main` |

## Step 1 — Confirm the commit is the one on main

```bash
git fetch origin main
git merge-base --is-ancestor 46068ca904bea3024b20abcf0f7e38fa8dda3d20 origin/main && echo ON_MAIN || echo NOT_ON_MAIN
git grep -n filterValueRejection origin/main -- supabase/functions/muse-executive/index.ts
```

**Expected:** `ON_MAIN`, and a line in `index.ts` that calls `filterValueRejection` before the query. `NOT_ON_MAIN` means stop. Do not redeploy.

## Step 2 — Redeploy `muse-executive`

Lovable → Edge Functions → `muse-executive` → redeploy. No other function. No Publish.

Unauthenticated, this stays 401 before and after. It only proves the route exists:

```bash
B=https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1
curl -s -o /dev/null -w '%{http_code}\n' "$B/muse-executive/executive/workboard"
```

**Expected:** `401`. `404` means the function is not deployed at all.

## Step 3 — Distinguish the old 503 from the new 400

Use the existing Muse read token (`Authorization: Bearer` or `X-Muse-Token`). Do not print the token. Do not mint a new one.

```bash
H=(-H "Authorization: Bearer $MUSE_TOKEN")
curl -s -w '\n%{http_code}\n' "${H[@]}" \
  "$B/muse-executive/executive/workboard?mission_id=6f14b53d"
```

**Expected after this redeploy:** HTTP `400` and a JSON body that parses as exactly:

```json
{"error":"invalid_filter","field":"mission_id","message":"mission_id must be a full 36-character UUID; omit it to list all"}
```

Whitespace from `JSON.stringify(..., null, 2)` does not matter. Parse it.

* `503` with `"The executive view could not be read."` → ❌ old function still deployed. Redeploy did not land. Do not change the database to make the truncated id query succeed.
* `400` with `field` `mission_id` and that message → ✅ the filter check is live.
* `401` → the token was missing or rejected. This check did not run.

Repeat for the other two id filters. Each must be HTTP 400 with `field` equal to the param name and the same message shape:

```bash
curl -s -o /tmp/muse-task.json -w '%{http_code}\n' "${H[@]}" \
  "$B/muse-executive/executive/workboard?task_id=6f14b53d"
curl -s -o /tmp/muse-imp.json -w '%{http_code}\n' "${H[@]}" \
  "$B/muse-executive/executive/work-feed?improvement_id=6f14b53d"
python3 -c 'import json; print(json.load(open("/tmp/muse-task.json"))["field"]); print(json.load(open("/tmp/muse-imp.json"))["field"])'
```

**Expected:** both statuses `400`, then the lines `task_id` and `improvement_id`.

## Step 4 — A real id still reads, and the success body is unchanged

```bash
curl -s -o /tmp/muse-ok.json -w '%{http_code}\n' "${H[@]}" \
  "$B/muse-executive/executive/workboard?mission_id=6f14b53d-4c16-49ec-a475-a1bf94229499&limit=1"
python3 -c 'import json; d=json.load(open("/tmp/muse-ok.json")); print(d["resource"], d["row_count"], sorted(k for k in d if k!="notes"))'
```

**Expected:** HTTP `200`. Printed resource is `workboard`. `row_count` is an integer (it moves as posts arrive; do not update rows to force a number). Keys besides an optional `notes` are exactly:

`authoritative_source`, `confidence`, `data`, `data_timestamp`, `evidence`, `freshness_minutes`, `generated_at`, `human_verification_required`, `resource`, `row_count`, `status`

`error` must not be present. A `503` here is a real read failure: the body must be `error` `read_failed`, `message` `"The executive view could not be read."`, and `code` a 5-character SQLSTATE, a `PGRST` code, or `unavailable`. Report that body. Do not treat it as a bad filter, and do not edit data.

Omitting the id still lists the board:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "${H[@]}" \
  "$B/muse-executive/executive/workboard?limit=1"
```

**Expected:** `200`.

## Report back

1. `ON_MAIN` or `NOT_ON_MAIN`, and whether you redeployed. Name the button: Lovable → Edge Functions → `muse-executive` → redeploy.
2. The HTTP status and parsed JSON of `mission_id=6f14b53d`.
3. The two statuses and the two `field` lines for `task_id` and `improvement_id`.
4. The status and the python line from the full-UUID read.
5. The status of the read with no `mission_id`.
6. Confirm you did not run SQL, did not Publish, and did not redeploy any other function.

## Do not

* Do not edit a migration. There is not one for this fix.
* Do not mark the 400 verified because the unit tests passed. Verification is the live HTTP body above.
* Do not store or repeat the Muse token.
* Do not "fix" a remaining 503 on a full UUID by writing rows or altering the view.
