# Handoff — Activate the Muse workboard loop (Muse → Grok Bot → Claude)

**For:** Grok Bot as Chief of Staff, plus whoever holds database or agent-config access for the
steps marked otherwise. Rule this serves: [`CLAUDE.md`](../CLAUDE.md) → handoff prompt.
Background: [`HANDOFF_MUSE_WORKBOARD_WRITE_PATH.md`](./HANDOFF_MUSE_WORKBOARD_WRITE_PATH.md),
[`HANDOFF_MUSE_DAILY_IMPROVEMENT_DEPLOY.md`](./HANDOFF_MUSE_DAILY_IMPROVEMENT_DEPLOY.md).

Everything is **deployed**. Nothing is **operating**. This handoff makes work flow.

---

## Status going in (live, read-only probe on 2026-10-08)

| Thing | State | Evidence |
|---|---|---|
| Schema (16 `muse_*` tables, 17 views) | ✅ live | catalog query |
| `muse-executive` (read API) | ✅ live | unauthenticated GET → `401`; 8 successful reads in the last 7 days |
| `muse-workboard` (write API) | ✅ deployed | GET → `405`, POST with no token → `401` |
| Telegram reclassified DORMANT | ✅ live | `telegram-webhook` / `telegram-outbox` `is_active = false` |
| **Write path ever used** | ❌ **never** | `muse_workboard_requests` = **0 rows** |
| **Board content** | ❌ empty | `muse_missions` 0 · `muse_improvement_tasks` 0 · `muse_work_updates` 0 |
| **Muse's credential** | ⚠️ read-only | every read in `muse_access_audit` is labelled `env-bootstrap` (the `MUSE_API_TOKEN` secret), which **cannot** write |
| Write-capable token | ⚠️ exists, unused | one row in `muse_api_tokens`: label `thoth`, scopes `read`, `workboard:write`, not revoked |
| Grok Bot runtime | ❌ not wired | nothing reads `/executive/agent-queue` or writes back |
| Signed-in UI (`/muse/missions`, `/daily`, `/agents`, `/impact`) | ❓ never observed | every check so far hit the login redirect |

## Coordinates

| | |
|---|---|
| Functions base | `https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1` |
| Read API | `GET  {base}/muse-executive/executive/<resource>` |
| Write API | `POST {base}/muse-workboard` with `Authorization: Bearer <token>`, `Idempotency-Key: <8–120 chars [A-Za-z0-9_.:-]>`, JSON body `{"action": "...", "payload": {...}}` |
| Lovable project | `7fce9fc6-fd96-4a31-8a89-649f00298c51` (Supabase `wkzwcfmvnwolgrdpnygc`) |
| App | `https://fendi-control-center.lovable.app` |

**The token's label is the actor.** `muse-workboard` records `created_by`, `selected_by`,
`assigning_agent` and work-feed `actor` from the label of the token that made the call. One token
per agent, or the audit trail can't tell Muse from Grok.

---

## Who does what

| Step | Who can execute it |
|---|---|
| 1. Give Muse its write credential | Whoever configures Muse's runtime (Fendi, or an agent with access to Muse's secret store) |
| 2. Mint Grok Bot's own token | An agent with database access: Lovable SQL editor, or the Lovable MCP `query_database` tool |
| 3. Prove the write path end to end | **Grok Bot** (needs only HTTPS + its token from step 2) |
| 4. Run the daily loop | **Grok Bot** |
| 5. Signed-in UI check | An agent with a browser already signed in to the Control Hub |
| 6. Owner decisions | **Fendi only** |

Grok Bot can execute steps 3 and 4 on its own once step 2 is done. Steps 1 and 2 need someone
with secret or database access. Grok should not guess these or work around them.

---

## Step 1 — Give Muse a credential that can write

Muse currently reads with the bootstrap secret. Writes need a hashed token with
`workboard:write`.

1. Find out whether the existing `thoth` token is Muse's. Only the hash is stored, so the
   plaintext exists only wherever it was handed out on 2026-09-30.
   * **If Muse holds `thoth`:** configure Muse to send that token on **both** APIs, reads and
     writes. Done.
   * **If nobody can produce `thoth`'s plaintext:** mint a dedicated Muse token as in step 2, with
     label `muse`, and revoke `thoth`:
     `update public.muse_api_tokens set revoked_at = now() where label = 'thoth';`
2. Do **not** add `workboard:write` to the bootstrap secret. The write function only accepts
   hashed, registered tokens, by design.

**Verify:** after Muse's next run, this query must show Muse's label (not `env-bootstrap`) on
recent reads:

```sql
select token_label, count(*), max(at)
  from public.muse_access_audit
 where at > now() - interval '1 day' and http_status = 200
 group by 1;
```

## Step 2 — Mint Grok Bot's own token

Generate a random secret **outside the database**: 32+ bytes, for example
`openssl rand -base64 48 | tr -d '/+=' | head -c 48`. Store only its hash:

```sql
-- pgcrypto lives in the `extensions` schema here, so call it qualified. Paste the plaintext only into this statement,
-- never into chat, a commit or a log.
insert into public.muse_api_tokens (label, token_sha256, scopes, expires_at, notes)
values ('grok-bot',
        encode(extensions.digest('<plaintext>', 'sha256'), 'hex'),
        array['read','workboard:write'],
        now() + interval '90 days',
        'Grok Bot chief-of-staff credential; read + workboard write');
-- Expected: INSERT 0 1
```

Put the plaintext in Grok Bot's runtime secret store as `MUSE_TOKEN`. Then verify:

```sql
select label, scopes, revoked_at is null as live from public.muse_api_tokens order by created_at;
-- Expected: a row  grok-bot | {read,workboard:write} | t
```

## Step 3 — Prove the write path (Grok Bot)

Run these in order. Use clearly labelled verification records, never fake business content.

```bash
B=https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1
H=(-H "Authorization: Bearer $MUSE_TOKEN" -H "Content-Type: application/json")

# 3a. Negative checks
curl -s -o /dev/null -w '%{http_code}\n' "$B/muse-workboard"                                   # expect 405
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/muse-workboard"                           # expect 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST "${H[@]}" -H 'Idempotency-Key: verify-unknown-1' \
     -d '{"action":"drop_table","payload":{}}' "$B/muse-workboard"                            # expect 400

# 3b. Create one verification improvement
curl -s -X POST "${H[@]}" -H 'Idempotency-Key: verify-activation-impr-1' "$B/muse-workboard" -d '{
  "action":"create_improvement",
  "payload":{"domain_key":"ai_technical_systems",
             "problem":"[DEPLOYMENT VERIFICATION] workboard write path never exercised",
             "intervention":"[DEPLOYMENT VERIFICATION] one end-to-end write",
             "metric":"workboard requests recorded",
             "owner_attention":"NONE",
             "notes":"Verification record from HANDOFF_MUSE_ACTIVATION.md; close after step 3."}}'
# expect {"ok": true, ...} — record data.id as IMPR

# 3c. Same request again → no duplicate
#     (repeat 3b with the SAME Idempotency-Key) → expect "idempotent_replay": true

# 3d. Assign a task and see it in the queue
curl -s -X POST "${H[@]}" -H 'Idempotency-Key: verify-activation-task-1' "$B/muse-workboard" -d '{
  "action":"create_task",
  "payload":{"improvement_id":"<IMPR>","domain_key":"ai_technical_systems",
             "title":"[DEPLOYMENT VERIFICATION] confirm agent-queue pickup","executor":"Claude",
             "objective":"Prove a task written by Grok is readable by its executor"}}'
curl -s "${H[@]}" "$B/muse-executive/executive/agent-queue?executor=Claude"
# expect row_count >= 1 and the verification task in data[]

# 3e. Work feed
curl -s -X POST "${H[@]}" -H 'Idempotency-Key: verify-activation-note-1' "$B/muse-workboard" -d '{
  "action":"append_update",
  "payload":{"improvement_id":"<IMPR>","update_type":"NOTE",
             "message":"[DEPLOYMENT VERIFICATION] work feed write"}}'
curl -s "${H[@]}" "$B/muse-executive/executive/work-feed?actor=grok-bot"
# expect the note, with actor = grok-bot

# 3f. Close the verification records
#     update_task_state  {"task_id":"<TASK>","state":"CANCELLED","blocker":"verification complete"}
#     update_improvement_state {"improvement_id":"<IMPR>","status":"CLOSED","actual_result":"write path verified"}
```

**Expected database state after step 3:**

```sql
select (select count(*) from public.muse_workboard_requests) as requests,         -- >= 6
       (select count(*) from public.muse_improvements where problem like '[DEPLOYMENT VERIFICATION]%' and status = 'CLOSED') as closed_verification;  -- exactly 1
```

If `requests` is 0 after Grok reports success, the calls never reached the function. Report that.
Don't retry with a different token.

## Step 4 — Grok Bot's daily operating loop

Grok coordinates; it does not set business priorities and does not modify production.

**Morning read (every run):**

| Read | Why |
|---|---|
| `GET /executive/daily-improvements?status=PROPOSED` | What Muse has proposed today |
| `GET /executive/agent-queue?state=BLOCKED` and `?state=WAITING` | What is stuck |
| `GET /executive/verification-queue?state=CLAIMED` | Claims nobody has checked |
| `GET /executive/improvement-results?status=RUNNING` | Experiments whose review date has passed |
| `GET /executive/work-feed?limit=50` | What changed since the last run |

**Then, per item:**

1. **Assign.** For each Muse-proposed improvement whose `owner_attention` is `NONE` or `INFORM`,
   `create_task` with `executor` set to the right specialist (`Claude`, `Cursor`, …). For
   `APPROVAL`, `DECISION` or `DIRECT_INVOLVEMENT`, **do not assign.** `append_update` with
   `update_type: "DECISION"` so it surfaces for Fendi.
2. **Prevent duplicate work.** Before `create_task`, read
   `/executive/agent-queue?domain=<d>` and skip if an open task already covers it. Before Muse
   starts an experiment, check `/executive/daily-improvements?domain=<d>` for a `RUNNING` row on
   the same metric. If one exists, the right outcome is **observe, not intervene**.
3. **Chase blockers.** For each `BLOCKED` or `WAITING` task, `append_update` (`BLOCKER`) naming
   what it waits on. Escalate only if it needs Fendi.
4. **Verify, never self-verify.** When an executor marks a task `IMPLEMENTED`, a **different**
   agent checks the evidence, then calls `update_task_verification` at the level actually proven:
   `ARTIFACT_VERIFIED` (commit or PR), `SYSTEM_VERIFIED` (query or log), `LIVE_VERIFIED` (observed
   in production). Only then `update_task_state` → `COMPLETE`.
   *The database does not enforce this. `muse-workboard` lets any write token set any
   verification level. The rule holds only if Grok follows it.*
5. **Measure.** Record results with `record_measurement` (`BASELINE` before the change; `DAY_7` /
   `DAY_30` only once that time has actually passed). Leave the KEEP / REVISE / REVERSE verdict to
   Muse.

**Report to Fendi only:** `DECISION` or `APPROVAL` items, anything high-risk or irreversible,
and blockers only Fendi can clear. Everything else stays on the board.

## Step 5 — Signed-in UI check (browser agent)

Open `/muse/missions`, `/muse/daily`, `/muse/agents`, `/muse/impact` while signed in. After step
3, `/muse/agents` and the work feed should show the closed verification records. Record what
actually renders. **"Muse schema is not in this database yet"** would be a real finding.

## Step 6 — Owner decisions (Fendi)

These block domains from being measured at all. No agent should answer them:

1. Which system is authoritative for **Boltz revenue**?
2. Which **credential model** Muse uses to read other Supabase projects (unblocks Boltz Insight
   Engine and FanFuel / AGH)
3. Is **Tax & Credit Services** its own domain or part of The Workhouse?
4. Should Control Hub pitch and playlist tables remain a second copy of **music truth**?

---

## Report back

1. Which steps you ran, and how (SQL editor, MCP, curl).
2. Step 1: which label Muse now reads with (audit query output).
3. Step 2: the `muse_api_tokens` rows (labels and scopes only, **never** plaintext).
4. Step 3: each HTTP status and the final `requests` / `closed_verification` row.
5. Step 5: what each route rendered.

## Do not

* Do not put any token plaintext in chat, a commit, a PR, the work feed or a log.
* Do not give `workboard:write` to the bootstrap secret or share one token between agents.
* Do not use a service-role key as a Muse credential. Both functions reject it.
* Do not create real missions or improvements to "test". Use the `[DEPLOYMENT VERIFICATION]`
  records above and close them.
* Do not mark verification above what you actually observed, and never on your own claim.
* Do not route ordinary execution to Fendi.
