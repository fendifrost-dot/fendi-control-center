# Remote Bridge (Mac daemon)

Runs on your computer and connects the cloud control hub to local tools: shell, Cursor CLI, Claude CLI.

## Setup

1. Apply migration `20260602120000_remote_command_queue.sql` in Supabase.
2. Deploy edge functions: `remote-bridge-api`, updated `telegram-webhook`.
3. Set Supabase secrets:
   - `REMOTE_BRIDGE_TOKEN` — long random string (Mac daemon uses this)
   - `REMOTE_BRIDGE_ENQUEUE_KEY` — optional extra key for enqueue
   - `REMOTE_BRIDGE_DEVICE_NAME` — optional, default `primary-mac`
4. On your Mac:

```bash
export SUPABASE_URL="https://wkzwcfmvnwolgrdpnygc.supabase.co"
export REMOTE_BRIDGE_TOKEN="your-secret"
export REMOTE_BRIDGE_WORKDIR="$HOME/projects"
node /path/to/fendi-control-center/scripts/remote-bridge/run.mjs
```

Keep this running in tmux or launchd while you are away.

## Phone commands (Telegram)

- `/mac status` — is the bridge online?
- `/mac git status` — shell in workdir
- `/mac cursor fix the failing tax test` — Cursor agent CLI
- `/mac claude summarize my open PRs` — Claude CLI
- `run on my mac: ls ~/Desktop`

Full guide: `docs/REMOTE_CONTROL_HUB.md`
