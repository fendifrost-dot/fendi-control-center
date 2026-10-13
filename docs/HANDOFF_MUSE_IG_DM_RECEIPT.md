# Handoff — Enki Instagram DM receipt forwarder

Code is on the branch. Nothing in this file has been applied to the live project.
Do not treat a green local test as `LIVE`.

## Status going in

| Thing | State |
|---|---|
| Code | Commit `235bb5887d64ac08d5d1d4833ddd91b9bc6413a9` on `cursor/ig-dm-receipt-2278`. Not merged. Not deployed. |
| Schema in the live database | Not applied. `muse_workboard_requests_action_check` does not list `record_ig_dm_receipt`. |
| `muse-workboard` live | Old action list. `record_ig_dm_receipt` is rejected as `unknown_action`. |
| `MUSE_IG_RECEIPT_SECRET` on this project | Not set by this change. The value lives in Lovable Cloud, never in the repo. |
| FanFuel Hub | Already accepts `mark_manual_ig_dm_submitted` with `x-muse-ig-receipt-secret`. Spec: `fendifrost-dot/fan-growth-pilot` `docs/MUSE_IG_RECEIPT.md`. |
| Frontend published | Not published. Hub 403 / Hub 409 badges are not on the live site. |
| Validated locally | `deno test supabase/functions/muse-workboard/contract.test.ts --allow-env` (13 passed). `npm test` (100 passed). Not validated against the live hub. |

## Hard rules

* No `supabase` CLI. A 403 there is a false wall.
* No supabase.com dashboard for migrations.
* Do not ask Fendi to paste SQL or to paste `MUSE_IG_RECEIPT_SECRET`.
* SQL goes in the Lovable SQL editor for project `7fce9fc6-fd96-4a31-8a89-649f00298c51`.
* The secret goes in Lovable Cloud secrets for that same project. Do not write it into a file, a commit, a chat, or a browser bundle.
* Edge functions go through Lovable → Edge Functions → redeploy. Name the function: `muse-workboard`.
* Frontend goes through Lovable → Publish.
* Publish is not an edge redeploy.
* Do not merge this PR as part of the deploy. Merge is a separate decision.
* Do not edit the migration to make it run. If it errors, stop and report the error.
* Do not create a mission to make the board insert succeed.
* Do not call this action against a live `APPROVED_FOR_SEND` handoff unless that Instagram DM was already sent by a person. This path records a receipt. It does not send the DM.
* Do not put the pitch, the send brief, or a link to the song into `notes` or `reference`.

## Coordinates

| | |
|---|---|
| Lovable project id | `7fce9fc6-fd96-4a31-8a89-649f00298c51` |
| Supabase project | `wkzwcfmvnwolgrdpnygc` |
| Repo | `github.com/fendifrost-dot/fendi-control-center` |
| Migration | `supabase/migrations/20261013170000_muse_ig_dm_receipt_action.sql` |
| Function to redeploy | `muse-workboard` |
| Secret | `MUSE_IG_RECEIPT_SECRET` on this project. Same value as FanFuel Hub `control-center-api`. Distinct from `FANFUEL_HUB_KEY`, `GROK_PLAYLIST_CONTROL_SECRET`, the Claude secrets, and `OUTREACH_SCHEDULER_SECRET`. |
| Hub URL | `FANFUEL_HUB_URL` must already be an `https` origin. The function posts `{origin}/functions/v1/control-center-api`. |
| Board mission | `6f14b53d-4c16-49ec-a475-a1bf94229499` |
| Frontend | Publish after the function is redeployed, so a refusal row can show a Hub 403 or Hub 409 badge. |

## What the action does

`POST /functions/v1/muse-workboard` with the existing Muse bearer (`workboard:write`) and an `Idempotency-Key`.

```json
{
  "action": "record_ig_dm_receipt",
  "payload": {
    "handoff_record_id": "<agh_handoff_records.id>",
    "reference": "ig-dm-thread-8841",
    "notes": "Sent the approved DM from the operator account.",
    "submitted_at": "2026-10-13T15:04:00.000Z"
  }
}
```

The function posts this to FanFuel Hub, and only this:

```json
{
  "action": "mark_manual_ig_dm_submitted",
  "handoff_record_id": "<same id>",
  "evidence": {
    "result": "submitted",
    "reference": "<same reference>",
    "notes": "<same notes>",
    "submitted_at": "<same instant>"
  }
}
```

Header on that server-side request: `x-muse-ig-receipt-secret: <MUSE_IG_RECEIPT_SECRET>`. No `x-api-key`. No `Authorization` carrying the secret. The browser allow-list does not include `x-muse-ig-receipt-secret`.

The HTTP status and JSON body returned to Enki are the hub's status and body. `403` stays `403`. `409` stays `409`. They are not rewritten to `400`.

A hub `403` writes a `BLOCKER` on the mission above. A hub `409` writes a `STATUS`. The message starts with `IG_DM_RECEIPT_REFUSED` and includes `hub_status: 403` or `hub_status: 409`. It does not include `notes`. The work feed and the executive brief show a `Hub 403` or `Hub 409` badge for that prefix. Other statuses are returned and are not posted to the board.

`submitted_at` is UTC with a `Z` suffix, and not more than a minute in the future.

## Step 1 — Apply the migration

Run the full file `supabase/migrations/20261013170000_muse_ig_dm_receipt_action.sql` in the Lovable SQL editor. One shot. Do not drop the constraint by hand first.

### Step 1a — Verify it landed

```sql
select position('record_ig_dm_receipt' in pg_get_constraintdef(oid)) > 0 as action_ok
from pg_constraint
where conname = 'muse_workboard_requests_action_check';
```

**Expected exactly one row:** `action_ok` true.

If there is no row, or `action_ok` is false, the audit check was not replaced. Do not call `record_ig_dm_receipt` until it is true. A hub call would still run, and the audit insert would then fail, so a retry would not replay.

```sql
select count(*) as mission_ok
from public.muse_missions
where id = '6f14b53d-4c16-49ec-a475-a1bf94229499';
```

**Expected:** `mission_ok` = 1. If it is 0, stop. Receipt refusals cannot be posted on the board until that mission exists. Do not insert a replacement mission. Report the count.

## Step 2 — Set the secret, then redeploy `muse-workboard`

In Lovable Cloud secrets for project `7fce9fc6-fd96-4a31-8a89-649f00298c51`, set `MUSE_IG_RECEIPT_SECRET` to the same value already set on FanFuel Hub `control-center-api`. Confirm `FANFUEL_HUB_URL` is the FanFuel Hub `https` origin.

Then Lovable → Edge Functions → redeploy `muse-workboard`.

Do not redeploy `muse-executive` for this change. Do not Publish yet.

### Step 2a — Verify the function, not the receipt

```bash
B=https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1
curl -s -o /dev/null -w '%{http_code}\n' "$B/muse-workboard"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/muse-workboard" \
  -H 'Content-Type: application/json' \
  -d '{"action":"record_ig_dm_receipt","payload":{}}'
```

* GET `405` → method guard still holds.
* POST `401` → deployed, anonymous write refused.
* POST `404` → the function is not deployed.
* POST `200` → wrong. Anonymous callers must not record a receipt.

With Enki's Muse token (`workboard:write`):

```bash
H=(-H "Authorization: Bearer $MUSE_TOKEN" -H 'Content-Type: application/json')
curl -s -o /tmp/ig-receipt-unknown.json -w '%{http_code}\n' -X POST "${H[@]}" \
  -H 'Idempotency-Key: ig-receipt-unknown-action-1' \
  -d '{"action":"mark_manual_ig_dm_submitted","payload":{}}' \
  "$B/muse-workboard"
```

**Expected:** `400`, body `{"error":"unknown_action"}`. The hub action is not a workboard action. If this returns anything else, the allowlist did not deploy.

```bash
curl -s -o /tmp/ig-receipt-shape.json -w '%{http_code}\n' -X POST "${H[@]}" \
  -H 'Idempotency-Key: ig-receipt-shape-check-1' \
  -d '{"action":"record_ig_dm_receipt","payload":{"handoff_record_id":"00000000-0000-4000-8000-000000000000","reference":"shape-check","notes":"MUSE_IG_SEND_BRIEF exact paste","submitted_at":"2026-10-13T15:04:00.000Z"}}' \
  "$B/muse-workboard"
```

**Expected:** `400`, and the body `error` contains `without pasting the pitch`. The hub must not be called. `notes` in that body must not be the brief text.

If this returns `503` and `error` is `MUSE_IG_RECEIPT_SECRET is not configured` or `FANFUEL_HUB_URL is not configured` / `FANFUEL_HUB_URL must be https`, the secret or URL is missing. Fix the secret, redeploy `muse-workboard` again, and repeat this shape check. A `400` on the pitch notes is the pass.

```bash
curl -s -D /tmp/ig-receipt-headers.txt -o /tmp/ig-receipt-miss.json -w '%{http_code}\n' -X POST "${H[@]}" \
  -H 'Idempotency-Key: ig-receipt-missing-handoff-1' \
  -d '{"action":"record_ig_dm_receipt","payload":{"handoff_record_id":"00000000-0000-4000-8000-000000000000","reference":"ig-dm-thread-shape","notes":"Sent the approved DM from the operator account.","submitted_at":"2026-10-13T15:04:00.000Z"}}' \
  "$B/muse-workboard"
python3 -c 'import json; print(json.load(open("/tmp/ig-receipt-miss.json")))'
```

**Expected:** the HTTP status is the hub's status, not `400`. For this id the hub body is `handoff record not found` at `404`. A `400` with `unknown_action` means the redeploy did not land. A `400` with `write failed` means the forwarder threw. A body that contains `MUSE_IG_RECEIPT_SECRET` or the secret value is a failure: stop and report it.

`grep -i muse-ig-receipt-secret /tmp/ig-receipt-headers.txt` must print nothing. The response must not carry the receipt header.

Do not repeat `ig-receipt-missing-handoff-1`. A second call with that key replays the stored response and does not hit the hub again.

## Step 3 — Publish the frontend

Lovable → Publish.

Open `/muse/feed` and `/muse` while signed in. A refusal row is not created by Step 2 (a missing handoff is `404`, and `404` is not posted). The badges appear when a real hub `403` or `409` has been stored. Until then, the pages should load as they do today. A blank board or a missing-schema error is a finding. Report it. Do not invent a refusal row.

## Step 4 — Only after a real send

When a person has already sent an approved Instagram DM, Enki calls `record_ig_dm_receipt` with a new idempotency key, the real `handoff_record_id`, a short reference, a one-line note, and the actual `submitted_at`.

If the hub answers `403` or `409`:

```sql
select update_type, left(message, 80) as message_start, evidence_ref
from public.muse_work_updates
where mission_id = '6f14b53d-4c16-49ec-a475-a1bf94229499'
  and message like 'IG_DM_RECEIPT_REFUSED%'
order by created_at desc
limit 5;
```

**Expected for a 403:** one new row, `update_type` = `BLOCKER`, `message_start` begins `IG_DM_RECEIPT_REFUSED` and the next line is `hub_status: 403`. The note text is absent.

**Expected for a 409:** one new row, `update_type` = `STATUS`, `hub_status: 409`.

Signed-in `/muse/feed` and `/muse` show `Hub 403` or `Hub 409` on that row. The workboard HTTP status for that call is `403` or `409`, and the body is the hub JSON.

A `200` from the hub is a recorded receipt. It does not add a refusal row. Do not send a second receipt for the same handoff to "see" a `409`. The hub treats a second stamp as an idempotent replay, which is `200`, not `409`.

## Report back

1. The SQL `action_ok` value and the `mission_ok` count.
2. Whether `MUSE_IG_RECEIPT_SECRET` was set in Lovable Cloud. Do not include the value.
3. Which button was pressed: Edge Functions → redeploy `muse-workboard`, and whether Publish was pressed.
4. The four HTTP statuses from Step 2a, and the missing-handoff JSON body.
5. Confirmation that the response headers and body did not contain the secret.
6. If a real `403` or `409` happened: the workboard HTTP status, the `muse_work_updates` row, and whether the badge showed. If none happened, say that. Do not mark the badge verified.

## Do not

* Do not edit the migration or the forwarder to make a check pass.
* Do not grant `anon` access to `muse_workboard_requests` or `muse_work_updates`.
* Do not send `FANFUEL_HUB_KEY` as the receipt secret. A copied broader secret does not authenticate as Muse.
* Do not put the secret in `VITE_` env, the client, or `Access-Control-Allow-Headers`.
* Do not mark this live because the contract tests passed.
