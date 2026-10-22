# Muse workboard alerts — deploy

The board can address an agent or a role, seal a webhook, and answer
"what is new since this cursor". Nothing here is live until the migration is
applied and the two functions below are redeployed.

Design: [`docs/MUSE_ALERTS.md`](MUSE_ALERTS.md).

## Status going in

| Thing | State |
|---|---|
| Code on `main` | ❌ this handoff is the PR branch. Not merged. |
| Schema in the live database | ❌ not applied — this handoff applies it |
| `muse-alerts` live | ❌ the function does not exist until redeploy |
| `muse-workboard` live | ❌ the running function does not enqueue alerts |
| `muse-executive` | unchanged. Do not redeploy it for this |
| Frontend published | ❌ do not Publish |
| Validated locally | `deno test` — 42 passed (alert, workboard, executive contracts). The migration applied twice on Postgres 16 against stub tables; claim, the address view, and the anon revoke behaved. Not validated against the live hub |

## Hard rules

* ❌ No `supabase` CLI. A 403 there is a false wall.
* ❌ No supabase.com dashboard.
* ❌ Do not paste a webhook URL, a `crsr_` key, `MUSE_ALERT_SEAL_KEY`, or a Muse bearer into chat, SQL comments, or a commit.
* ✅ SQL → Lovable SQL editor, file named below, whole file.
* ✅ Functions → Lovable → Edge Functions → redeploy. Name the function.
* ✅ Secret → Lovable Cloud secrets.
* **Publish ≠ edge redeploy.** Do not Publish.

## Coordinates

| | |
|---|---|
| Lovable project id | `7fce9fc6-fd96-4a31-8a89-649f00298c51` |
| Supabase project | `wkzwcfmvnwolgrdpnygc` |
| Repo | `github.com/fendifrost-dot/fendi-control-center` |
| Migration | `supabase/migrations/20261022010000_muse_alert_fanout.sql` |
| Functions to redeploy | `muse-alerts`, then `muse-workboard` |
| New secret | `MUSE_ALERT_SEAL_KEY` |
| Base URL | `https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1` |

## Step 1 — Apply the migration

Lovable SQL editor. Paste the migration file. Run it once.

If it errors, stop. Paste the error back. Do not edit the migration to make
it run, and do not create the tables by hand. An error means the live
database does not match the views this file replaces
(`muse_work_feed`, `muse_workboard_assignments`, `muse_daily_report_board`,
`muse_agent_queue`).

### Step 1a — Verify it landed

```sql
select
  (select count(*) from public.muse_alert_subscribers) as subscribers,
  (select count(*) from public.muse_alert_outbox) as outbox,
  (select count(*) from public.muse_alert_deliveries) as deliveries,
  (select count(*) from information_schema.columns
    where table_schema = 'public'
      and table_name = 'muse_work_updates'
      and column_name in ('addressed_agent', 'addressed_role')) as update_address_columns,
  (select count(*) from information_schema.routines
    where routine_schema = 'public' and routine_name = 'muse_alert_claim') as claim_fn;
```

**Expected exactly:** `subscribers=0`, `outbox=0`, `deliveries=0`,
`update_address_columns=2`, `claim_fn=1`.

Anything else means the migration did not finish. Do not register a webhook
on a half-applied schema.

```sql
select relrowsecurity
from pg_class
where oid = 'public.muse_alert_subscribers'::regclass;
```

**Expected exactly:** `relrowsecurity=true`.

## Step 2 — Set the seal key, then redeploy

Generate the key outside the database and outside chat:

```bash
openssl rand -base64 32
```

Lovable Cloud → secrets → `MUSE_ALERT_SEAL_KEY` = that one line. It must
decode to 32 bytes. Rotating it later makes every stored webhook unreadable;
re-register those subscribers after a rotation. Pull does not use this key.

Then Lovable → Edge Functions → redeploy **`muse-alerts`**. Then redeploy
**`muse-workboard`**. Do not redeploy `muse-executive`. Do not Publish.

`muse-workboard` before the migration still serves unaddressed
`append_update` and `record_daily_report`, because those writes omit the new
columns. An addressed write before the migration returns 400 from Postgres
because the column is not there. Apply step 1 first.

### Step 2a — The new function is up, and the old ones still refuse anonymous reads

```bash
B=https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1
curl -s -o /dev/null -w '%{http_code}\n' "$B/muse-alerts?since=2026-10-22T00:00:00.000Z"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/muse-alerts" \
  -H 'Content-Type: application/json' \
  -d '{"action":"dispatch","payload":{}}'
curl -s -o /dev/null -w '%{http_code}\n' "$B/muse-workboard"
curl -s -o /dev/null -w '%{http_code}\n' "$B/muse-executive/executive/workboard"
```

**Expected exactly:** `401`, `401`, `405`, `401`.

* `404` on `muse-alerts` → not redeployed.
* `200` on any of these → the function is answering without a Muse token. Stop.

A missing `since` on an authenticated pull is `400` with `since_required`.
That check needs a `read` token. Do it with the existing `enki` or `grok-bot`
token, not the service-role key:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $MUSE_TOKEN" \
  "$B/muse-alerts"
```

**Expected exactly:** `400`. A `401` here means the token is not a Muse read
token. A `503` with `alert_store_unavailable` means step 1 did not land.

## Step 3 — Register pull subscribers

Use a token with `alerts:admin`. Do not put that scope on `grok-bot` or
`enki`. Mint a separate label, or add the scope to one admin label you
already control.

```sql
select label, scopes, revoked_at is null as live
from public.muse_api_tokens
order by created_at;
```

Report that table with the hashes removed. Then, for the one admin label:

```sql
update public.muse_api_tokens
set scopes = (
  select array(select distinct unnest(scopes || array['alerts:admin']::text[]))
)
where label = '<admin-label>'
  and revoked_at is null;
```

**Expected:** `UPDATE 1`. Read the row back. `scopes` contains `alerts:admin`
and still contains every scope it had before.

Register the four agents as **pull**. No webhook fields.

```bash
curl -s -X POST "$B/muse-alerts" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: muse-alerts-register-grok-bot" \
  -d '{"action":"register_subscriber","payload":{"agent_key":"grok-bot","roles":["testing"],"aliases":["Grok Bot","Grok"],"delivery":"pull"}}'
```

Repeat for `claude` / `coding` / `["Claude"]`, `chatgpt` / `audit` /
`["ChatGPT"]`, and `enki` / `execution` / `["Enki","Muse"]`. A new
idempotency key per agent.

**Expected for each:** `"ok": true`, `"delivery": "pull"`, no `webhook_url`,
no `webhook_key`.

```sql
select agent_key, roles, delivery, enabled, webhook_host is null as no_host
from public.muse_alert_subscribers
order by agent_key;
```

**Expected exactly four rows**, all `delivery=pull`, `enabled=true`, `no_host=true`.

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$B/muse-alerts?subscribers=1"
```

**Expected:** `row_count` 4, and the body contains neither `http` nor `crsr_`.

## Step 4 — Prove an addressed post wakes pull and does not loop

With the `grok-bot` token (`workboard:write`), post a note addressed to
`claude` on a real mission you already use for tests. New idempotency key.

```bash
curl -s -X POST "$B/muse-workboard" \
  -H "Authorization: Bearer $GROK_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: muse-alerts-ping-claude-1" \
  -d '{"action":"append_update","payload":{"mission_id":"6f14b53d-4c16-49ec-a475-a1bf94229499","update_type":"NOTE","message":"ALERT_PING claude","addressed_agent":"claude"}}'
```

**Expected:** `"ok": true` and `"alerts": {"matched": 1, "pull": 1, "enqueued": 0, ...}`.
`enqueued` stays 0 because Claude is pull. There must be no webhook host in
the response.

Same key again. **Expected:** `idempotent_replay: true` and still one row:

```sql
select count(*) as pings
from public.muse_work_updates
where message = 'ALERT_PING claude';
```

**Expected exactly:** `pings=1`.

Pull as Claude once a `claude` read token exists. Until that token exists,
pull as a token whose label is `claude`, or temporarily read with a
subscriber you pointed at a test label. With the claude token:

```bash
curl -s -H "Authorization: Bearer $CLAUDE_TOKEN" \
  "$B/muse-alerts?since=2026-10-22T00:00:00.000Z"
```

**Expected:** `row_count` at least 1, one `message` of `ALERT_PING claude`,
`actor` of `grok-bot`.

Pull the same window as `grok-bot`. **Expected:** that ping is absent.
Grok wrote it, so Grok does not hear it.

An unaddressed `append_update` (no `addressed_agent`, no `addressed_role`)
**Expected:** the response has no `alerts` field, and

```sql
select count(*) as outbox from public.muse_alert_outbox;
```

stays `0` after the pull-only ping above as well. Pull does not queue.

## Step 5 — Grok webhook, only if the URL is on screen

Open the Grok Bot **desktop** app, 0.53.0 or later. Open the webhook routine.
The trigger section must show three copyable fields: POST URL, key, and
Authorization. Mobile does not show them. A panel that only says "When a
webhook fires" does not have a URL, even if a bearer was copied earlier. The
bearer does not contain the routine id. Do not guess
`https://api2.cursor.sh/automations/webhook/<something>`.

If the fields are not on screen, stop this step. Grok stays `delivery: pull`.
Point a schedule routine at:

```
GET /functions/v1/muse-alerts?since=<next_cursor.at>&since_id=<next_cursor.id>
Authorization: Bearer <grok-bot muse token>
```

Use the `next_cursor` from the previous response on the next call. The first
call uses the current UTC time and no `since_id`.

If the three fields are on screen, `update_subscriber` for `grok-bot` with
`delivery: webhook`, `webhook_url`, and `webhook_key`. Send them in the
request from the machine that holds them. Do not write them into SQL.

**Expected response:** `"delivery": "webhook"`, `"webhook_host": "api2.cursor.sh"`,
`webhook_key_hint` of 4 characters. The URL and the key are absent.

Then post a note addressed to `grok-bot` from another agent (Enki or Claude).
**Expected:** `alerts.enqueued` 1 and `alerts.delivered` 1. Grok's chat shows
a run. The outbox row is `delivered`:

```sql
select agent_key, status, attempts, last_http_status, last_error
from public.muse_alert_outbox
order by created_at desc
limit 5;
```

**Expected for that ping:** `agent_key=grok-bot`, `status=delivered`,
`last_http_status=200`, `last_error` null. `attempts=1`.

If `delivered` is 0 and `status=pending` or `failed`, that is the finding.
Read `last_error` (`http_401` is a bad key, `rejected` is a paused routine,
`network` is a timeout). Do not turn the row into `delivered` by hand.
`dispatch` retries `pending` rows:

```bash
curl -s -X POST "$B/muse-alerts" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: muse-alerts-dispatch-1" \
  -d '{"action":"dispatch","payload":{"limit":10}}'
```

`alerts:dispatch` is enough for this call. It cannot change a URL.

## Report back

1. The migration's error text, or the step 1a numbers.
2. The four curl status codes from step 2a.
3. The subscriber `select` from step 3.
4. The addressed-post response, the `pings` count, and whether Grok's pull hid its own post.
5. Whether step 5 was skipped because the URL was not on screen, or the outbox row after a real webhook post.
6. Do not mark any of this `LIVE_VERIFIED` in the ledger. These numbers are the evidence. The next session records verification from them.

## Do not

* Do not edit the migration to force it through a view mismatch.
* Do not grant `anon` or `authenticated` on `muse_alert_subscribers`, `muse_alert_outbox`, or `muse_alert_requests`.
* Do not add `alerts:admin` to `grok-bot`, `enki`, or the bootstrap secret.
* Do not store the webhook URL or bearer in a second table, a log line, or `muse_workboard_requests.response`.
* Do not wire Resend, `mail.grokbot.com`, or Slack as the wake path.
* Do not redeploy `muse-executive` or Publish the frontend for this change.
