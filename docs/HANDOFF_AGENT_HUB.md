# Agent Hub — implementation and review record (first delivery, 12–13 Oct 2026)

Guide: [`AGENT_HUB.md`](AGENT_HUB.md). This file is the evidence: what changed, what was
tested, what is live, what is not, and where a reviewer can check each claim.

## Status at a glance

| Piece | State | Evidence |
|---|---|---|
| Migration `20261012230000_agent_hub.sql` | **LIVE** (applied via Lovable SQL, 12 Oct ~23:10 UTC) | 9 agent rows, bucket `agent-hub`, mission `a9e3c1f0-…`, widened `remote_command_queue_type_check` |
| Migration `20261013010000_agent_hub_token_label_unique.sql` | **LIVE** | index `agent_hub_agents_token_label_key` |
| `agent-hub` edge function | **LIVE** from `e55c33b` | Lovable deploy, `source_sha256 e834e894…`; anonymous `{"action":"inbox"}` → 401 |
| `/agents` app, manifest, icons | **LIVE** (Lovable publish) | `fendi-control-center.lovable.app/agents` 200; `/manifest.webmanifest` 200 `application/manifest+json` |
| Grok (xAI API) reviewer | **LIVE, verified** | handoff `1c107286…` answered in 13.8 s |
| Claude Code cloud agent (token) | **LIVE, verified** | handoff `b9980498…` answered via `respond` |
| ChatGPT model (OpenAI API) | Key present, **not yet exercised** | `health` → `unverified` |
| Mac bridge (Claude Code / Cursor / Codex on the Mac, iMessage) | **CODED, awaiting Mac** | last heartbeat 2026-06-09; needs `git pull` + restart |
| Grok Bot, Enki answering through the hub | **Awaiting one directive each** | handoffs to them are mirrored to the workboard |

PRs: #60 (`907fcfe`, everything), #61 (`e55c33b`, review fixes), plus this record.

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
