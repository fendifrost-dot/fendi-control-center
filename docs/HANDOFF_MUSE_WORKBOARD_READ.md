# Handoff — Enki reads the Muse workboard

The rule this serves is in [`CLAUDE.md`](../CLAUDE.md). The API Enki should call is
[`MUSE_WORKBOARD_READ.md`](./MUSE_WORKBOARD_READ.md).

## Status going in

| Thing | State |
|---|---|
| Code on `main` | ❌ this branch only, until the PR merges |
| `muse_executive_brief` section `workboard` | ✅ applied on Lovable project `7fce9fc6-fd96-4a31-8a89-649f00298c51` during the coding session (2026-10-12). Re-applying the migration is safe. Re-pasting `20260925120000_muse_executive_layer.sql` would drop the section. |
| `muse_workboard_assignments` | ✅ created in that same apply |
| `enki` token scopes | ✅ unchanged: `{read, workboard:write}`, not revoked. No new scope. |
| `muse-executive` edge function | ❌ not redeployed. `/executive/workboard`, `/executive/assignments`, and `?since=` are not live. `/executive/brief` and `/executive/work-feed` are the deployed function. |
| Frontend published | ❌ the signed-in brief page does not yet render section `workboard` |
| `muse-workboard` writes | unchanged. Do not redeploy it for this change. |

Verified on the live database immediately after the apply:

```sql
select section, count(*) as n from public.muse_executive_brief group by 1 order by 1;
```

| section | n |
|---|---|
| blockers | 2 |
| decisions_required | 4 |
| priorities | 2 |
| system_failures | 1 |
| waiting | 1 |
| workboard | 8 |

Rank 1 of section `workboard` was `NOTE from grok-bot · 2026-10-12T01:22:38Z`,
`item_id` `2a169a62-f1a3-4993-9c2e-c278538c9b67`, `detail` length 2346, starting
`MUSE_IG_SEND_BRIEF part 5/5`, `source_ref` `6f14b53d-4c16-49ec-a475-a1bf94229499`.
`muse_workboard_assignments` had 9 rows, 8 of them on that mission inside 48 hours.

Those counts move as new posts arrive and as the 48-hour window slides. The rank-1
check below is the stable one while that note is still inside the window (until
about 2026-10-14 01:22 UTC). After that, the row must still be on `muse_work_feed`.

## Hard rules

* ❌ No `supabase` CLI. A 403 there is a false wall.
* ❌ Do not re-paste `supabase/migrations/20260925120000_muse_executive_layer.sql`.
* ❌ Do not edit this migration to make it run. If it errors, paste the error back.
* ❌ Do not add a scope, and do not grant `anon` anything.
* ❌ Do not redeploy `muse-workboard`. Writes stay as they are.
* ✅ SQL, if you re-apply: Lovable SQL editor, file
  `supabase/migrations/20261012020000_muse_workboard_read_surface.sql`.
* ✅ Then **Lovable → Edge Functions → redeploy `muse-executive` only**.
* ✅ Frontend section label: **Lovable → Publish**. Publish does not redeploy the function.

## Coordinates

| | |
|---|---|
| Lovable project id | `7fce9fc6-fd96-4a31-8a89-649f00298c51` |
| Supabase project | `wkzwcfmvnwolgrdpnygc` |
| Repo | `github.com/fendifrost-dot/fendi-control-center` |
| Migration | `supabase/migrations/20261012020000_muse_workboard_read_surface.sql` |
| Function to redeploy | `muse-executive` |

## Step 1 — Confirm the brief section is still there

```sql
select rank, title, length(detail) as chars, left(detail, 40) as detail_start, source_ref
from public.muse_executive_brief
where item_id = '2a169a62-f1a3-4993-9c2e-c278538c9b67';
```

**Expected while the note is inside 48 hours:** one row, `rank` 1,
`title` = `NOTE from grok-bot · 2026-10-12T01:22:38Z`, `chars` = 2346,
`detail_start` = `MUSE_IG_SEND_BRIEF part 5/5 (exact paste):`,
`source_ref` = `6f14b53d-4c16-49ec-a475-a1bf94229499`.

Zero rows before 2026-10-14 01:22 UTC means the view was replaced by the old brief
definition. Re-apply this migration. Do not invent a replacement view.

## Step 2 — Redeploy `muse-executive`

Unauthenticated checks do not tell you whether the new resources exist. Missing
token is 401 for every path:

```bash
B=https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1
curl -s -o /dev/null -w '%{http_code}\n' "$B/muse-executive/executive/workboard"   # 401
curl -s -o /dev/null -w '%{http_code}\n' "$B/muse-workboard"                       # 405
```

With Grok Bot's Muse token (it has `read`):

```bash
H=(-H "Authorization: Bearer $MUSE_TOKEN")
# Before redeploy this is 404 unknown_resource. After redeploy it is 200.
curl -s -o /dev/null -w '%{http_code}\n' "${H[@]}" \
  "$B/muse-executive/executive/workboard?mission_id=6f14b53d-4c16-49ec-a475-a1bf94229499"
```

* `404` → the old function is still deployed.
* `200` → redeploy landed. Then:

```bash
curl -s "${H[@]}" \
  "$B/muse-executive/executive/workboard?mission_id=6f14b53d-4c16-49ec-a475-a1bf94229499&limit=5" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); row=d["data"][0]; print(d["row_count"]); print(row["update_type"], row["created_at"]); print(row["message"][:48])'
```

**Expected:** `row_count` >= 1, first row `NOTE`, `created_at` starting `2026-10-12T01:22:38`,
message starting `MUSE_IG_SEND_BRIEF part 5/5`. Newer posts after that note may sit above it.
If they do, this note must still be in `data` (raise `limit`, or `since=2026-10-12T01:22:00Z`).

```bash
curl -s "${H[@]}" \
  "$B/muse-executive/executive/assignments?mission_id=6f14b53d-4c16-49ec-a475-a1bf94229499&since=2026-10-12T00:00:00Z" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); types=sorted({r["update_type"] for r in d["data"]}); print(d["http_status"] if "http_status" in d else d["row_count"], types)'
```

**Expected:** a row count >= 7 and types only `ASSIGNMENT` and `NOTE`. A `STATUS` row is a failure.
`since=2026-10-12T00:00:00+00:00` must be HTTP 400 (the `+` form is rejected on purpose).

Brief, same token, no redeploy required for this one:

```bash
curl -s "${H[@]}" "$B/muse-executive/executive/brief" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); rows=[r for r in d["data"] if r["section"]=="workboard"]; print(len(rows)); print(rows[0]["title"] if rows else "MISSING")'
```

**Expected while the Oct 12 note is inside 48 hours:** count >= 1 and the first workboard
title is the newest post. `MISSING` means the view regressed or the response was truncated
below the workboard rows (default limit is 200; the board currently has far fewer).

## Step 3 — Publish only if the signed-in page should show the section

**Lovable → Publish.** Then open `/muse` (the brief) signed in. Section
"Workboard (last 48 hours)" lists the same notes. This does not affect Enki's API read.

## Report back

1. Whether you re-applied the migration, and the step 1 row (or the error text).
2. The HTTP status of authenticated `GET /executive/workboard` before and after the `muse-executive` redeploy.
3. The python prints from the workboard, assignments, and brief checks.
4. Whether you published. If you did not, say so.

## Do not

* Do not mark `/executive/workboard` live because an unauthenticated call returned 401.
* Do not point Enki at a Google Doc. The message body on the workboard is the pack.
* Do not give the bootstrap secret `workboard:write`.
