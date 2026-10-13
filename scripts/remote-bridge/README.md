# Remote Bridge (Mac daemon)

Runs **on your Mac** and connects the cloud control hub to local tools: shell, Cursor CLI, Claude CLI.

**Cursor Cloud agents cannot run this for you** — they run on Linux and have no access to your machine.

## Quick start (Mac Terminal)

```bash
cd /path/to/fendi-control-center/scripts/remote-bridge
./start-mac.sh
```

First run creates `~/.fendi-remote-bridge.env`. Set `REMOTE_BRIDGE_TOKEN` to the same value as the Supabase secret, then run again.

**Background (tmux):**

```bash
tmux new -s fendi-bridge
./start-mac.sh
# Detach: Ctrl+B then D
```

## Setup

1. Apply migration `20260602120000_remote_command_queue.sql` in Supabase.
2. Deploy edge functions: `remote-bridge-api`, updated `telegram-webhook`.
3. Set Supabase secrets:
   - `REMOTE_BRIDGE_TOKEN` — long random string (Mac daemon uses this)
   - `REMOTE_BRIDGE_ENQUEUE_KEY` — optional extra key for enqueue
   - `REMOTE_BRIDGE_DEVICE_NAME` — optional, default `primary-mac`

## Phone commands (Telegram)

- `/mac status` — is the bridge online?
- `/mac git status` — shell in workdir
- `/mac cursor fix the failing tax test` — Cursor agent CLI
- `/mac claude summarize my open PRs` — Claude CLI
- `run on my mac: ls ~/Desktop`

Full guide: `docs/REMOTE_CONTROL_HUB.md`  
Deploy handoff: `docs/CLAUDE_HANDOFF_REMOTE_CONTROL_HUB.md`

## Agent Hub (Oct 2026)

The bridge also runs **Agent Hub handoffs** (`agent_handoff`): Claude Code, Cursor or Codex
reviews or works on the exact commit in a per-thread worktree under `~/.fendi-bridge/threads`,
resumes the same CLI session on follow-ups, and posts the answer back to the thread.
Claude runs with `ANTHROPIC_API_KEY` removed so it always uses your Max login.
It also handles `imessage_send`, `imessage_read` and reports what this Mac can do.
Setup and permissions: `docs/AGENT_HUB.md` → "Setup still needed on your side".
Test: `node --test scripts/remote-bridge/agentHandoff.test.mjs`.
