# Handoff — Muse Instagram send queue on `muse-executive`

Fendi, 2026-10-22: the approved Instagram path is **Claude finds the curators and composes
the DM inside the Hub → Grok approves it in the Hub → Muse sends it on Instagram → Muse
records the receipt.** No hand-send lane. No author waiver.

Control Center already had the receipt half (`muse-workboard` `record_ig_dm_receipt`). This
adds the read half, so Muse pulls the exact approved text and handle from the Hub instead of
re-typing a pack from the board.

## What changed

| Where | Change |
|---|---|
| `supabase/functions/muse-executive/contract.ts` | `IG_SEND_QUEUE_RESOURCE`, `hubSendQueueRequest` (POST `list_ig_dm_send_queue` to the Hub with `x-muse-ig-receipt-secret`), `igSendQueueEnvelope` (Hub 200 → `KNOWN` envelope; anything else → `503`, secret scrubbed). |
| `supabase/functions/muse-executive/index.ts` | `GET /executive/ig-send-queue` pass-through, audited like every other resource; listed in the index with a one-line note on the path. |
| `contract.test.ts` | 3 new tests (16 total, pass). `deno check` clean. |

Hub side (already on `fan-growth-pilot` `main`, commit `fa9ca5a`): the `list_ig_dm_send_queue`
action and the Muse credential widened to call it. See
`fan-growth-pilot/docs/HANDOFF_IG_SEND_PATH_MUSE.md`.

## Status going in

| Thing | State |
|---|---|
| Code | On the branch / merged per the PR. Not live until `muse-executive` is redeployed. |
| Secrets | `MUSE_IG_RECEIPT_SECRET` and `FANFUEL_HUB_URL` already exist on this project (the receipt forwarder uses them). Nothing new to set. |
| Hub | Must be redeployed with the new action first, or this endpoint answers `503 hub_unavailable` with `hub_status: 403`. |

## Hard rules

* No `supabase` CLI, no supabase.com dashboard. Edge functions go through Lovable →
  Edge Functions → redeploy. Name the function: `muse-executive`.
* No SQL in this change. No Publish needed.
* Do not send a DM to test this.

## Step 1 — Redeploy `muse-executive`

Lovable → Edge Functions → redeploy `muse-executive`. Nothing else.

### Verify

```bash
B=https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1
curl -s -o /dev/null -w '%{http_code}\n' "$B/muse-executive/executive/ig-send-queue"
```

**Expected:** `401` (anonymous refused). `404` means not deployed.

With Enki's Muse token (`read` scope):

```bash
curl -s -H "Authorization: Bearer $MUSE_TOKEN" "$B/muse-executive/executive/ig-send-queue" | head -c 600
```

**Expected:** `200`, `resource` = `ig-send-queue`, `status` = `KNOWN`, `send_owner` = `muse`,
`row_count` ≥ 0. A `503` with `hub_status: 403` means the Hub's `control-center-api` has not
been redeployed with `list_ig_dm_send_queue` yet, or the two projects hold different values
for `MUSE_IG_RECEIPT_SECRET`.

`GET /executive` (the index) must list `/executive/ig-send-queue`.

## Step 2 — Enki's loop, every weekday pack

1. `GET /executive/ig-send-queue`.
2. For each row with `sendable: true`: send `dm_body` to `ig_handle` exactly as written.
3. Record each send with `muse-workboard` `record_ig_dm_receipt` (`handoff_record_id` from the
   row, a short reference, a one-line note, the real `submitted_at`).
4. Rows with `blockers` are skipped and named on the board with the blocker. They belong
   to Grok (`draft_pending`, `draft_rejected`) or Claude (`ig_handle_missing`), never to
   Enki.
5. Never hand-send, never edit the copy, never send a row twice. The Hub replays a second
   receipt for the same record as idempotent and refuses a send of anything not approved.

## Report back

1. The anonymous status and the index listing.
2. From the token read: `row_count`, `sendable_count`, and `hub_status` if it was a 503.
3. The first receipt that comes back `200` through `record_ig_dm_receipt`, with its
   `handoff_record_id`.
