# Handoff — Activate the Muse workboard loop (Enki → Grok Bot → Claude)

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
| `thoth` token | ✅ read-only again (2026-10-08, Claude) | `thoth` is Fendi's verification token (minted on Fendi's Mac 2026-09-26 for `verify-muse-live.mjs`), **not** Muse's. Muse is **Enki**. It had been given `workboard:write` by mistake and never used it. Scope set back to `{read}`: `UPDATE 1`, verified |
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

Ordered so Fendi is the **last resort**. The only thing in this whole list that truly needs a human
is the four business decisions (step 6). Everything else needs either an agent's own runtime or
database access.

| # | Step | Status / who |
|---|---|---|
| 0 | Return `thoth` to read-only | ✅ **done** by Claude Code, 2026-10-08 |
| 1 | Enki token: **generate** the secret and keep it in Enki's own secret store | **Enki** itself if its platform has a secret store; otherwise Fendi |
| 1b | Enki token: **register its hash** (`label = 'enki'`) | **Claude agent** with the Lovable MCP (`query_database`) or the Lovable SQL editor. The hash is not a secret and can be pasted to it |
| 2 | Grok token: generate and keep the secret | **Grok Bot** itself if its runtime has a secret store; otherwise Fendi |
| 2b | Grok token: register its hash (`label = 'grok-bot'`) | **Claude agent**, same as 1b |
| 3 | Prove the write path end to end | **Grok Bot** (HTTPS + its token) |
| 4 | Daily operating loop | **Grok Bot** |
| 5 | Signed-in UI check | **Claude agent** with a browser signed in to the Control Hub; otherwise Fendi (2 minutes, 4 pages) |
| 6 | Four business decisions | **Fendi only** |

**Why the agents, not Claude Code, hold the secrets.** A token's plaintext must live only where it
is used. Claude Code's cloud sandbox is not allowed to create credentials. The safe pattern:

1. The **agent that will use the token** generates it and stores it in its own secret store.
2. It computes `sha256(token)` and passes **only the hash** to a Claude agent with database access.
   A hash is safe to share: it can't be turned back into the token.
3. The Claude agent inserts the hash. The plaintext never leaves the agent that owns it.

One-liner for step 2 of that pattern, if the agent or person has a shell:
`T=$(openssl rand -hex 32); echo "store this in your secret store: $T"; printf %s "$T" | sha256sum | cut -d' ' -f1`
(only the last line, the hash, goes to the Claude agent).

### Paste-ready prompts

**→ Enki (Muse):**
> Generate a random 32-byte secret (64 hex chars) and store it in your own secret store as
> `MUSE_TOKEN`. Do not show it to anyone. Compute its SHA-256 hex digest and report **only the
> digest**, labelled "enki hash". From now on, send `Authorization: Bearer $MUSE_TOKEN` on every
> call to `muse-executive` (reads) and `muse-workboard` (writes), instead of the bootstrap key.
> Coordinates and rules: `docs/HANDOFF_MUSE_ACTIVATION.md` in fendifrost-dot/fendi-control-center.

**→ Grok Bot:**
> Same as Enki, but store it as `MUSE_TOKEN` in *your* runtime and report "grok-bot hash". Once
> the hash is registered, run steps 3 and 4 of `docs/HANDOFF_MUSE_ACTIVATION.md` and report the
> results listed under "Report back".

**→ Claude agent with the Lovable MCP or SQL editor (steps 1b, 2b):**
> Register these Muse API token hashes in the Control Center database (Lovable project
> `7fce9fc6-fd96-4a31-8a89-649f00298c51`). Run the `insert` in step 2 of
> `docs/HANDOFF_MUSE_ACTIVATION.md` once per hash, but with the **hash value directly** in
> `token_sha256` (no `digest()` call, because you have the hash, not the token). Use label `enki`
> for Enki's hash and `grok-bot` for Grok's. Then run the token-register check in step 1 and
> report the rows (labels and scopes only).

**→ Claude agent with a signed-in browser (step 5):** run step 5 below and report what renders.

**→ Fendi (only if an agent above can't):** generate the token(s) with the one-liner above on
your Mac, put each plaintext into Enki's / Grok's settings, and send the hashes to Claude. Then
make the four decisions in step 6.

## Step 1 — Give Enki (Muse) its own write credential

**Muse is Enki.** Enki currently reads with the bootstrap secret (`env-bootstrap` in the audit
log) and has no token that can write. Writes need a hashed token with `workboard:write`.

1. Mint a dedicated token labelled **`enki`**, exactly as in step 2 but with `label = 'enki'`
   and notes `'Enki (Muse executive agent); read + workboard write'`. The label becomes the
   actor on everything Enki writes.
2. Put the plaintext in Enki's runtime configuration. Enki then sends it on **both** APIs:
   `muse-executive` for reads and `muse-workboard` for writes.
3. **Do not hand Enki the `thoth` token.** `thoth` is Fendi's verification credential, not
   Enki's. It has never written anything (`muse_workboard_requests` = 0 rows), and its
   `workboard:write` scope was granted to the wrong agent. **Done 2026-10-08** (Claude Code via
   Lovable MCP, `UPDATE 1`, scopes now `{read}`). For reference, the statement was:

   ```sql
   update public.muse_api_tokens set scopes = array['read'] where label = 'thoth';
   -- Expected: UPDATE 1. verify-muse-live.mjs keeps working; it only reads.
   ```
4. Do **not** add `workboard:write` to the bootstrap secret. The write function only accepts
   hashed, registered tokens, by design.

**Verify:** after Enki's next run, recent reads must show `enki`, not `env-bootstrap`:

```sql
select token_label, count(*), max(at)
  from public.muse_access_audit
 where at > now() - interval '1 day' and http_status = 200
 group by 1;
```

and the token register should read:

```sql
select label, scopes, revoked_at is null as live from public.muse_api_tokens order by created_at;
-- Expected after steps 1–2: thoth {read} t · enki {read,workboard:write} t · grok-bot {read,workboard:write} t
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
        NULL,  -- no expiry: Fendi decides when to expire or revoke a token
        'Grok Bot chief-of-staff credential; read + workboard write');
-- Expected: INSERT 0 1
```

**If you were given a hash rather than the token** (the normal path; see "Who does what"), put
the hash in directly: `token_sha256 = '<64-hex-hash>'`, with no `digest()` call.

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
2. Step 1: which label Enki now reads with (audit query output), and whether `thoth` is back to `{read}`.
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
