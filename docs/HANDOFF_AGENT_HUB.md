# Agent Hub — implementation and review record

Guide: [`AGENT_HUB.md`](AGENT_HUB.md). This file is the evidence: what changed, what was
tested, what is live, what is not, and where a reviewer can check each claim.

- **First delivery** (12–13 Oct 2026): PRs #60, #61, #62 — the live Claude → Grok → Claude round trip below.
- **Second review** (13 Oct 2026, findings 1–6 on `42d401f`): PR #64 (`32a476d`) plus this record —
  see [Second review](#second-review--findings-16-on-42d401f).

## Status at a glance (13 Oct 2026, after PR #64)

| Piece | State | Evidence |
|---|---|---|
| Migrations `20261012230000`, `20261013010000` | **LIVE** | 9 agent rows; unique `token_label` index |
| Migration `20261013030000_owner_only_access.sql` | **LIVE** (Lovable SQL, dry run rolled back first) | 1 owner row; 60 owner-gated policies; 0 policies still "any signed-in user" |
| Migration `20261013031000_agent_hub_integrity.sql` | **LIVE** (rolled-back test first) | constraint `agent_hub_messages_reserved_kinds`, index `agent_hub_messages_one_answer_per_handoff`, functions `agent_hub_record_response`, `agent_hub_fail_handoff` |
| `agent-hub`, `remote-bridge-api` edge functions | **LIVE** from `32a476d` | Lovable deploy: `agent-hub` `source_sha256 1ab4e10b…`, `remote-bridge-api` `2c8d6496…` |
| `/agents` app, manifest, icons, long-file-chip fix | **LIVE** (published) | bundle `index-CKNfnkGI.js` contains `truncate … dir:"rtl"`; `/manifest.webmanifest` served |
| Grok (xAI API) reviewer | **LIVE, verified** | handoff `1c107286…` answered in 13.8 s |
| Claude Code cloud agent (token) | **LIVE, verified** | handoffs `b9980498…`, `52e64ae2…` answered via `respond` |
| Owner sign-in through the real app | **NOT YET VERIFIED** | owner's last sign-in on record: 2026-04-13; Chrome on the Mac has no Control Center session; needs Fendi once (see end) |
| ChatGPT model (OpenAI API) | Key present, **not exercised** | `health` → `unverified` |
| Mac bridge (Claude Code / Cursor / Codex on the Mac, iMessage) | **CODED, not running** | last heartbeat 2026-06-09, June version; see finding 5 |
| Grok Bot, Enki answering through the hub | **Awaiting one directive each** | handoffs to them are mirrored to the workboard |

## The round trip (live, real work)

Thread **`87e35184-547a-4c5c-99b6-57c9baea4313`** — "Review: agent-hub auth and respond path (PR #60)".
Open it at `/agents/t/87e35184-547a-4c5c-99b6-57c9baea4313`.

| # | UTC (13 Oct) | Who | What | Row |
|---|---|---|---|---|
| 1 | 01:01:49 | Claude Code (cloud) | WORK: security-critical excerpts of `agent-hub` at exact commit `907fcfe`, 4 code attachments, PR link | message `8ea2f0f9` |
| 2 | 01:01:59 | Claude Code (cloud) | REVIEW handoff to Grok (xAI API) with instructions | handoff `1c107286` |
| 3 | 01:02:15 | Grok (xAI API) | REVIEW: 3 blocking + 3 non-blocking findings, 5 unverifiable items | message `5564f619` |
| 4 | 01:03:07 | Claude Code (cloud) | *Return to origin* → FEEDBACK handoff back to Claude (picked up from its inbox) | handoff `b9980498` |
| 5 | 01:08:59 | Claude Code (cloud) | REVISION: fixes merged as `e55c33b` (PR #61), redeployed; one finding pushed back with reasons | message `e89f4d27` |

The packet Grok received is stored verbatim in `agent_hub_handoffs.context` for `1c107286`
(source body, all four attachment texts, exact commit, PR URL). xAI usage recorded in
`delivery`: 2,565 prompt + 388 completion (+609 reasoning) tokens, `cost_in_usd_ticks`
55,643,500 ≈ **$0.0056**. xAI reported the serving model as `grok-4.3` for the requested
id `grok-3-mini-fast`; the hub records what the provider reports.

### What the review changed
- **Finding 1 (race, accepted):** `recordResponse` now claims the handoff with one
  conditional update before writing; verified live by sending the revision twice
  concurrently — exactly one stored (`answers = 1` for `b9980498`), the second call got
  `400 handoff already answered or cancelled`.
- **Finding 2 (respond guard, partly accepted):** identity already came from the token label;
  `respond` now also rejects non-agent actors explicitly.
- **Finding 3 (JWT, pushed back):** `getUser` validates against this project only. Any user
  signed in to this project counts as Fendi — the existing Control Center convention.
- **Unverified item (token_label uniqueness):** was not enforced; unique index added.

### Negative checks run against the live function
| Call | Result |
|---|---|
| `respond` twice concurrently to one handoff | 1 × 200, 1 × 400 |
| `respond` to a handoff addressed to `grok-api`, with the Claude token | 400 `this handoff is addressed to grok-api` |
| `decide` with an agent token | 400 `only Fendi (signed in) can do this` |
| Any action with no token | 401 |

## Tests
- `deno test supabase/functions/agent-hub/contract.test.ts` — 8 pass (availability is computed
  from evidence; packet carries exact revision, attachments, shortened history).
- `deno check supabase/functions/agent-hub/index.ts` — clean.
- `node --test scripts/remote-bridge/agentHandoff.test.mjs` — 3 pass, with a stand-in `claude`
  CLI: review runs on the **old** commit in a per-thread worktree, in `plan` mode, with
  `ANTHROPIC_API_KEY` stripped; the follow-up passes `--resume <session>` in the same directory.
- `tsc`, `vite build`, `vitest` (85 pass). CI on PRs #60 and #61: `web` and `deno-edge` green.
- Phone-width (390 × 844) screenshots of the **published** app showing the real thread, no page
  errors. The screenshot run had no Fendi login, so read requests were re-sent with the agent
  token; the data is real, the sign-in is not.

## Limitations (honest list)
- **Mac side untested on a real Mac.** CLI flags for `claude`, `cursor-agent` and `codex` follow
  their documented non-interactive modes; `codex exec … resume` and Cursor session ids are the
  least certain and fall back to a fresh session if resume fails. First real run will tell.
- **iMessage read** uses `chat.db` text only; messages stored only as rich text are skipped.
  Send needs the macOS Automation prompt accepted once.
- **Agent sessions are pull-based.** Claude Code cloud, Grok Bot and Enki see handoffs only
  when they check their inbox; Control Center cannot wake them.
- **Model API reviewers see text only** — no repo browsing; they say what they couldn't verify.
- **No web push yet.** Telegram pings Fendi when an agent answers; iOS web push for the
  Home Screen app is a possible next step.
- **ChatGPT app conversations cannot be read.** Content from the ChatGPT/Claude/Grok apps
  comes in by paste (in-app) or an iOS Shortcut; the OpenAI API agent is a separate thing.
- The `claude-code-cloud` token expires 2026-11-11; future sessions mint their own.
- A first attempt at the demo thread (`6e040f6d…`) had its message garbled by shell quoting;
  it was archived, not deleted.

## How to re-verify (cheap)
1. `POST …/functions/v1/agent-hub {"action":"inbox"}` without a token → **401** (deployed) vs 404.
2. SQL: `SELECT status, response_message_id IS NOT NULL FROM agent_hub_handoffs WHERE thread_id='87e35184-547a-4c5c-99b6-57c9baea4313'` → 2 rows, both `RESPONDED`, both `true`.
3. In the app: *Agents* tab → Grok (xAI API) and Claude Code (cloud session) green; Mac agents grey with the last-heartbeat date.

Don't: edit the migrations to make them run, switch the Grok reviewer to a pricier model
without asking, or give `claude-code-mac` an API key (Max-only policy).


---

## Second review — findings 1–6 on `42d401f`

Checked against current main first: nothing in these areas had changed since `42d401f`.

### 1. Owner identity — reproduced, worse than reported, fixed

| Evidence (before) | How |
|---|---|
| Two accounts: `fendifrost@gmail.com` (password login, last sign-in 2026-04-13) and `system@fendi.local` (id `00000000-…`, role `service_role`, no password, no identity, never signed in — the zero-UUID used by `telegram-webhook` audit rows). Only the first can sign in. | `auth.users`, `auth.identities` |
| Public signup is **on** for this project's auth API (`disable_signup: false`); the app has no signup screen, but the API accepts one. | `GET /auth/v1/settings` |
| Every operator RLS policy (60, across credit, tax, Muse, bridge and Agent Hub tables, plus the tax and agent-hub storage buckets) allowed any signed-in user. A signed-in stranger (made-up user id, rolled-back transaction) read **34 of 34 clients** and every Agent Hub message. | `set local role authenticated` + fake `sub`, then `rollback` |
| `anon` (the public key in the JS bundle) could EXECUTE six SECURITY DEFINER functions, including `delete_client_and_related_data` and `claim_remote_command_rows`. Confirmed with the read-only one: anon `rpc/list_workflows` → **200, 28 rows**. | REST call with the anon key |
| `current_personal_info`, `current_tradelines`, `current_inquiries` were readable by anon and ran with their creator's rights (RLS bypassed). They held 0 rows, so nothing leaked. | count-only `HEAD` request |

Fix (`20261013030000_owner_only_access.sql`, applied live):
- `control_center_owners` (seeded with Fendi's user id) and `is_control_center_owner()`.
- Every "signed in" policy rewritten to the owner check (names, commands and roles kept); tax and
  agent-hub bucket policies owner-gated; `workflows` no longer readable without a login.
- `anon` loses all table grants; the credit views run as the caller (`security_invoker`).
- The six definer functions are service-role only, except client deletion: the original body is now
  `delete_client_and_related_data_impl` (service role only) behind an owner-checking wrapper with the
  old name, so the Clients page keeps working.
- `agent-hub` returns **403** for a signed-in non-owner; `remote-bridge-api` refuses to queue Mac
  commands for one.

Verified after applying:

| Check | Before | After |
|---|---|---|
| Stranger reads `clients` / `agent_hub_messages` / `muse_work_updates` | 34 / 6 / 33 | 0 / 0 / 0 |
| Stranger calls `delete_client_and_related_data` | allowed | `42501 Only the Control Center owner can delete clients` |
| Owner reads `clients`, `agent_hub_messages` | 34, 6 | 34, 6 (unchanged) |
| anon `rpc/list_workflows`, `current_personal_info`, `clients` | 200 | 401, 401, 401 |
| Policies still "any signed-in user" | 60 | 0 |

Not changed (decision for Fendi): turning public signup off in Lovable Cloud auth settings. With the
owner list it no longer grants access, so it is defence in depth, not a fix.

### 2. Reserved message types — reproduced, fixed

`create_thread` accepted any kind and `respond` accepted DECISION/SYSTEM; `post` blocked only two kinds,
so an agent could post IMPORT. The hub's own status lines were also authored as the requester
(`author_kind: human` when Fendi asked).

Fix: `authoredKind()` — agents may write MESSAGE, WORK, REVIEW, REVISION, FEEDBACK; Fendi may post
MESSAGE, WORK, FEEDBACK; DECISION only via `decide`, IMPORT only via `ingest`, SYSTEM only by the hub
(now authored `agent-hub`, with `requested_by` in context). The database enforces the same rule
(`agent_hub_messages_reserved_kinds`), so no future code path can bypass it.

Live, with the agent token: `create_thread kind=DECISION`, `post kind=SYSTEM`, `post kind=IMPORT`,
`respond kind=DECISION` → **400** each with the reason; `decide` → 400. In the rolled-back DB test,
raw inserts of an agent DECISION, an agent SYSTEM row, and an agent posing as `human` → `23514`.

### 3. Response durability — reproduced, fixed

Old path: mark RESPONDED → insert message → link it, in separate calls; an interruption between them
left a handoff "answered" with no answer, and the release-on-error path could itself fail. The bridge
also logged and dropped an answer if posting it back failed.

Fix:
- `agent_hub_record_response()` — one transaction locks the handoff, inserts the answer, links it,
  marks it answered, updates thread status and the CLI session. Retrying the **same** answer returns
  `duplicate` with the stored message; a **different** second answer is refused (`23505`); a late
  answer after a timeout (FAILED) is still accepted. Unique index: one answer row per handoff.
- `agent_hub_fail_handoff()` only fails a still-open handoff and writes its status line in the same
  transaction, so a timeout can never overwrite an answer. `cancel_handoff` is conditional too.
- Model calls record their transport first; a call still IN_PROGRESS after 10 minutes (edge worker
  killed) is swept to FAILED with a retry hint.
- Bridge: the answer is written to `~/.fendi-bridge/outbox/<handoff>.json` before the first post and
  re-sent each loop until accepted; final refusals are kept as `.rejected.json`, never deleted.

Rolled-back DB test (15 checks, all as expected): first answer `recorded`; same answer `duplicate`;
different answer `23505`; exactly 1 stored; handoff `RESPONDED` and linked; fail-after-answer → `false`,
status stays `RESPONDED`; a write that errors midway leaves `IN_PROGRESS` with 0 messages, and the
retry is `recorded`.

Live (thread `ae6827d1…`, archived after): two identical answers sent concurrently to handoff
`52e64ae2…` both returned message `a3b6be21…` (one `duplicate: true`); a later retry → same message,
`duplicate: true`; a different answer → 400; 1 stored answer, linked.

### 4. Workspace preservation — substantiated in code, fixed

`git checkout --detach --force` in an existing thread workspace discarded uncommitted edits and
orphaned detached commits; cleanup `rm -rf`'d any workspace whose directory mtime was 14 days old.

Fix (`scripts/remote-bridge/agentHandoff.mjs`):
- Before moving a workspace to a new revision, uncommitted changes and commits no branch contains are
  committed/pointed at `agent-hub/keep/<thread>-<UTC stamp>`; the run reports the branch.
- No `--force` anywhere; a refused checkout fails the handoff and leaves the workspace as it was.
- One handoff per workspace (lock beside it, reclaimed when its process is gone).
- Cleanup removes only workspaces idle 14+ days (recorded last use, not directory mtime), not locked,
  clean, HEAD on a branch or remote, via `git worktree remove` without `--force`; plain folders only
  when empty; everything else is kept and listed with the reason.

Tests (`node --test scripts/remote-bridge/*.test.mjs`, 14 pass, real git repos): dirty work kept on a
keep branch; detached commit kept; clean switch creates nothing; no `--force`; second handoff waits;
dead lock reclaimed; cleanup removes the clean one and keeps dirty / orphaned / plain / unknown /
recent / running ones; outbox survives a failed post, re-sends, retries 5xx/429, keeps 4xx.

### 5. Bridge reconciliation — the working path is a different daemon

Read-only inspection of the Mac (folders granted for this check: `~/.grokbot`, `~/agent-tools`,
both Control Center checkouts):

| Path | What it is | Evidence |
|---|---|---|
| **Working: Grok Bot → Claude** | Grok Bot runs in its own cloud workspace (`/workspace/handoffs` in its workboard posts). It reaches the Mac through **Grok's own local-exec daemon** (`~/.grokbot`, "serving local exec over the gateway"), which runs `~/.local/bin/claude -p "<handoff .md>"` with `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN`, `--output-format json`, `--name "Grok: …"`, under `caffeinate`, in repo worktrees, with results written to `~/Desktop` and PRs. | `~/.grokbot/local-exec-daemon.log` (1,180 lines; supervisor restarted 10 Oct; last backend contact 13 Oct 03:09 UTC); process snapshots in `~/agent-tools` (14–24 Sep) show those exact `claude -p` command lines, labelled "Grok-initiated" |
| **Monitored: Control Center bridge** | `scripts/remote-bridge/run.mjs` polling `remote-bridge-api`. | Heartbeats 3–9 Jun only; **0 commands ever queued** (`remote_command_queue` is empty); both Telegram `/mac status` attempts (3 Jun) went to Lane 2, not the bridge; no `run.mjs` in any Sep process snapshot. Both Mac checkouts hold the June `run.mjs` (md5 `5988407…` = repo at `d359636`), not the Agent Hub version. |

So the gap is not a version gap on the working path: Grok Bot → Claude traffic never touches Control
Center. The two `fendi-macbook` rows come from a registration bug — the API looked devices up under its
own default name instead of the reported one, so every bridge restart (3 Jun 00:20 and 00:58) made a new
row. Fixed in PR #64 (lookup by reported name, device id saved on the Mac, un-addressed commands
claimable by any bridge — previously they were filed under a name the running Mac never polled). The
stale row `97fa2adc…` is marked `revoked` (not deleted).

`~/fendi-control-center` (outside `Projects`) is a damaged copy (AppleDouble `._*` pack files,
1,516 changed files); use `~/Projects/fendi-control-center` (clean, `main` at `0d88714`).

### 6. Real user activation — partly done

- Published mobile fix: confirmed in the live bundle (above).
- Owner sign-in: **not verified**. The earlier phone screenshots replaced the sign-in with the agent token;
  this review did not repeat that. Your Chrome on the Mac has no Control Center session and the owner's
  last recorded sign-in is 2026-04-13. I do not enter passwords, so this needs you once (below).
- Integrations: Grok (xAI API) and Claude Code cloud — verified through the hub. ChatGPT API — key
  present, never called. Grok Bot / Enki — reachable by workboard mirror, never answered through the
  hub. Mac CLIs and iMessage — coded and tested off-Mac only; bridge not running.

### What remains (needs Fendi)

1. **Sign in once** in the Home Screen app (or `fendi-control-center.lovable.app/agents` in Safari), open
   the thread "Review: agent-hub auth and respond path (PR #60)", type a short note with *To: Note only*,
   send. That proves the owner path end to end; Claude checks `last_sign_in_at` and the note's row.
2. **Start the Control Center bridge** on the Mac (or tell Grok Bot to do it through its local exec):
   `cd ~/Projects/fendi-control-center && git pull --ff-only && cd scripts/remote-bridge && ./start-mac.sh`
   (keep it running in tmux). After that, *Agents → Claude Code (your Mac)* turns amber, then green on
   its first answer.
3. Optional: give Grok Bot the directive in `AGENT_HUB.md` so its Claude jobs go through the hub
   (handoff to `claude-code-mac`) instead of direct `claude -p`, which makes them visible in threads.

### Re-verify cheaply

```sql
-- owner model
select count(*) from control_center_owners;                                   -- 1
select count(*) from pg_policies where schemaname in ('public','storage')
  and (coalesce(qual,'')||coalesce(with_check,'')) like '%auth.uid() IS NOT NULL%'; -- 0
-- integrity
select count(*) from agent_hub_messages where handoff_id='52e64ae2-c61d-4a1d-a4bd-d0a8a970774d'
  and author_kind <> 'system';                                                 -- 1
```

`curl -X POST $SUPABASE_URL/rest/v1/rpc/list_workflows -H "apikey: <anon>"` → **401** (was 200).
