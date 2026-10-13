# Agent Hub

Control Center as the one place where Fendi talks to his AI agents, hands work from one
agent to another for review, and keeps the work, the reviews, the revisions and his
decisions together in one thread. Open it at **`/agents`** (Home Screen app on iPhone).

Review record for the first delivery: [`HANDOFF_AGENT_HUB.md`](HANDOFF_AGENT_HUB.md).

## How it fits together

```
 Phone / desktop (/agents)          agent-hub edge function                 receivers
 ─────────────────────────          ─────────────────────────                ─────────
 thread ─ message ─ "Send for  ──►  handoff row + immutable packet ──┬──►  Model APIs (Grok, OpenAI): called
 review" / "Return to X"             (instructions, source message,  │     from the function, answer posted back
                                      exact repo@sha, attachments,   ├──►  Mac CLIs (Claude Code, Cursor, Codex):
                                      recent thread history)         │     remote_command_queue → bridge runs the
                                                                     │     CLI in a per-thread worktree at that sha
                                                                     └──►  Agent sessions (Grok Bot, Enki, Claude
                                                                           Code cloud): their inbox via token;
                                                                           Grok Bot/Enki also get a workboard post
 answer appears in the same thread  ◄──  respond / bridge_result / model reply  (Telegram ping to Fendi)
```

Tables (`20261012230000_agent_hub.sql`): `agent_hub_agents`, `agent_hub_threads`,
`agent_hub_messages` (append-only), `agent_hub_handoffs` (one per send; `context` = the
exact packet the receiver got), `agent_hub_sessions` (CLI session per thread). Signed-in
users can read; every write goes through `agent-hub`, which enforces who is acting.
Threads may link to a Muse mission/task. The existing workboard, bridge queue and Remote
page are unchanged.

## What each integration really is

| Agent | What it connects to | Conversation state | Sign-in | Billing |
|---|---|---|---|---|
| Grok (xAI API) | xAI chat completions, from the edge function | Stateless; hub resends packet + recent thread | `Frost_Grok` secret (same key as the Telegram bot) | xAI per-token |
| ChatGPT model (OpenAI API) | OpenAI chat completions | Stateless | `OPENAI_API_KEY` secret, if set | OpenAI API per-token — **not** your ChatGPT app/plan, cannot see ChatGPT chats |
| Grok Bot | Your existing Grok Bot session (own workspace) | In Grok Bot | `grok-bot` Muse token | Grok Bot's runtime |
| Enki (Muse) | Enki's runtime | In Enki | `enki` Muse token | Enki's runtime |
| Claude Code (cloud session) | A claude.ai Claude Code session using the API | In that session; it cannot be woken, it checks its inbox | `claude-code-cloud` token (`agenthub` scope, expires 30 days) | Claude Max |
| Claude Code (your Mac) | `claude` CLI via the bridge | Real session on the Mac, resumed per thread (`--resume`) | Your Claude login; bridge strips `ANTHROPIC_API_KEY` | Claude Max |
| Cursor agent (your Mac) | `cursor-agent` CLI via the bridge | Resumed when the CLI returns an id | Your Cursor login | Cursor credits |
| Codex CLI (your Mac) | `codex exec` via the bridge | Resumed when possible (unverified) | Codex sign-in | ChatGPT plan if signed in with ChatGPT |

The status dot is computed from evidence on every read, never declared: model APIs are
green only after a successful call through the hub; Mac agents need a bridge heartbeat in
the last 90 s **and** the CLI reported by the bridge; token agents need to have answered
through the hub once.

## Using it

- **Talk to an agent**: open a thread, pick the agent in the *To* row, send.
- **Independent review**: on any message, *Send for review* → pick a reviewer. The packet
  includes the message, its attachments, the exact `repo@commit`, PR link, and recent
  thread history. Mac reviewers get a checkout of that commit; API reviewers get the text.
- **Return feedback**: on a review, *Return to <original agent>* sends it back as FEEDBACK;
  their answer lands as a REVISION replying to the review.
- **Decide**: *Approve* records a DECISION message from you.
- **From another app**: the download icon on `/agents` opens *Bring in from another app* —
  paste what ChatGPT/Claude/Grok produced (Paste button reads the clipboard), label the app,
  optionally send it straight to a reviewer.

## Agent API (for agents and scripts)

`POST https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/agent-hub` with
`Authorization: Bearer <token>` and JSON `{ "action": ..., ... }`.

| Action | Who | Params |
|---|---|---|
| `inbox` | agent token | `limit` → handoffs addressed to you, with `packet_markdown` |
| `respond` | agent token (addressee only) | `handoff_id`, `body`, optional `kind`, `context`, `attachments`, `session_id` |
| `create_thread` | anyone | `title`, `body`, `kind` (`WORK`), `context` {`repo`,`commit_sha`,`pr_url`,`files`,`evidence`}, `attachments` [{`name`,`text`}] |
| `post` | anyone | `thread_id`, `body`, optional `to_agent` + `purpose` (makes a handoff) |
| `handoff` | anyone | `thread_id`, `source_message_id`, `to_agent`, `purpose` (`REVIEW`/`TASK`/`QUESTION`/`REVISE`/`FEEDBACK`), `instructions` |
| `return_to_origin` | anyone | `message_id` (a review) → FEEDBACK to the author of the reviewed work |
| `thread`, `threads`, `agents`, `health` | anyone | read |
| `decide`, `set_thread_status`, `cancel_handoff`, `retry_handoff`, `imessage_send`, `imessage_read` | Fendi (signed in) | |
| `ingest` | Fendi or an `agenthub:ingest` token | `source_app`, `body`, `title`, `url`, `to_agent` |
| `bridge_capabilities`, `bridge_result` | Mac bridge token | |

Signing in is not enough to act as Fendi: the account must be listed in `control_center_owners`
(non-owners get 403, and every operator table policy checks the same list). Message kinds are
enforced: agents cannot write DECISION, IMPORT or SYSTEM; answers are stored once, and retrying the
same answer returns the stored one.

Tokens are rows in `muse_api_tokens` (SHA-256 only). Scope `agenthub` or `workboard:write`,
and the label must equal the agent's `token_label`.

## Setup still needed on your side

### 1. Mac bridge (enables Claude Code / Cursor / Codex on your Mac, and iMessage)

Two different things run on your Mac — don't confuse them:

- **Grok Bot's local-exec daemon** (`~/.grokbot`, installed by Grok). This is how Grok Bot already
  starts `claude -p` jobs. It works today, but those jobs do not appear in Control Center.
- **The Control Center bridge** (`scripts/remote-bridge`). This is what the Agent Hub monitors and uses
  for *Claude Code (your Mac)*, Cursor, Codex and iMessage. It last ran 3–9 June 2026 (June version)
  and never executed a command.

Start the current bridge from the clean checkout (not `~/fendi-control-center`, which is a damaged copy).
You can also ask Grok Bot to run this through its local exec:

```bash
cd ~/Projects/fendi-control-center && git pull --ff-only
cd scripts/remote-bridge && ./start-mac.sh        # keep it running (tmux or a login item)
```

`~/.fendi-remote-bridge.env` from June is reused. The bridge now saves its device id in
`~/.fendi-bridge/device.json` (one row per Mac), keeps answers in `~/.fendi-bridge/outbox/` until the hub
accepts them, and never discards work in thread workspaces (`agent-hub/keep/…` branches).

Optional lines in `~/.fendi-remote-bridge.env` (the file is not overwritten):

```bash
export REMOTE_BRIDGE_REPOS='{"fendifrost-dot/fendi-control-center":"'"$HOME"'/Projects/fendi-control-center"}'
export REMOTE_BRIDGE_ALLOW_EDITS="0"   # 1 = TASK/REVISE handoffs may edit, in a per-thread worktree
```

Then in the app: *Agent Hub → Mac* should show **online** and list the CLIs it found.

- **iMessage send**: the first send triggers a macOS prompt — allow Terminal (or whatever
  runs the bridge) to control **Messages**.
- **iMessage read**: System Settings → Privacy & Security → **Full Disk Access** → add the
  app running the bridge. Without it, reads fail with a clear message. Newer macOS stores
  some messages only as rich text; those are skipped.
- **Codex**: `npm i -g @openai/codex` then `codex login` (ChatGPT account) if you want it.

### 2. Grok Bot and Enki — one directive each

Paste to each (replace the name):

> Control Center now has an Agent Hub. When the Muse workboard shows an ASSIGNMENT from
> `agent-hub` addressed to you, call `POST .../functions/v1/agent-hub` with
> `{"action":"inbox"}` using your existing Muse token, do the work in `packet_markdown`,
> then answer with `{"action":"respond","handoff_id":"<id>","body":"<your answer>"}`.
> Answer there, not on the workboard. Check the inbox at start of day and whenever you
> post to the workboard.

Optional extra for Grok Bot, once the Control Center bridge is running (step 1). It replaces direct
`claude -p` runs so each job and Claude's answer land in one thread you can open on your phone:

> For Claude Code jobs on Fendi's Mac, instead of running `claude -p` yourself, call agent-hub with
> `{"action":"create_thread","title":"<job>","kind":"WORK","body":"<the full handoff text>",
> "context":{"repo":"<owner/repo>","commit_sha":"<sha>"}}`, then
> `{"action":"handoff","thread_id":"<id>","source_message_id":"<message id>","to_agent":"claude-code-mac","purpose":"TASK"}`.
> Read Claude's answer with `{"action":"thread","thread_id":"<id>"}`.

### 3. iPhone

Open `https://fendi-control-center.lovable.app/agents` in **Safari** → Share → **Add to
Home Screen**. Sign in once inside the installed app (it keeps its own sign-in, separate
from Safari).

### 4. Optional: share-sheet shortcut from ChatGPT/Claude apps

The in-app *Bring in* sheet needs no setup. For one-tap sharing, ask Claude to mint an
`agenthub:ingest` token, then build an iOS Shortcut: *Receive Text from Share Sheet* →
*Get Contents of URL* (POST the API URL above, header `Authorization: Bearer <token>`,
JSON `{"action":"ingest","source_app":"chatgpt-app","body":<Shortcut Input>}`) → *Open
URLs* with `open_url` from the result.

## Deploy path (CLAUDE.md chain of command)

| Piece | Where it goes live |
|---|---|
| Migration | Lovable SQL (applied 2026-10-12 through the Lovable database tool) |
| `agent-hub` function | Lovable → Edge Functions → redeploy `agent-hub` |
| `/agents` UI, manifest, icons | Lovable Publish |
| Bridge | `git pull` + restart on the Mac |

Cheap checks: `POST agent-hub {"action":"health"}` with no token → **401** means deployed,
**404** means not deployed.
