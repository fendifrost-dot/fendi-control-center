# Claude Handoff — Remote Control Hub (final deploy & go-live)

**Purpose:** Execute the remaining steps to make the Remote Control Hub production-ready: database, edge functions, secrets, Telegram, Lovable frontend, and the Mac bridge daemon.

**Repo:** `fendifrost-dot/fendi-control-center`  
**Supabase project ID:** `wkzwcfmvnwolgrdpnygc`  
**Feature branch:** `cursor/remote-control-hub-b502`  
**PR:** [#12](https://github.com/fendifrost-dot/fendi-control-center/pull/12) (draft — merge to `main` first unless instructed otherwise)

**Architecture reference:** `docs/REMOTE_CONTROL_HUB.md`  
**Mac daemon:** `scripts/remote-bridge/README.md`

---

## Copy-paste prompt for Claude

```
You are finishing deployment of the Fendi Remote Control Hub in fendifrost-dot/fendi-control-center.

Read docs/CLAUDE_HANDOFF_REMOTE_CONTROL_HUB.md and execute every step in order.
Do not skip verification gates. Lovable publish does NOT deploy Supabase edge functions.

Goals when done:
- PR #12 merged (or branch synced to main)
- Migration 20260602120000_remote_command_queue.sql applied
- remote-bridge-api + telegram-webhook deployed
- REMOTE_BRIDGE_TOKEN set; Mac daemon running
- /remote works in browser (logged in); Telegram /mac status shows online
```

---

## What is already built (do not re-implement)

| Area | Location |
|------|----------|
| DB migration | `supabase/migrations/20260602120000_remote_command_queue.sql` |
| Edge API | `supabase/functions/remote-bridge-api/index.ts` |
| Telegram `/mac` routing | `supabase/functions/_shared/remoteBridgeTelegram.ts` + hook in `telegram-webhook/index.ts` |
| Mac daemon | `scripts/remote-bridge/run.mjs` |
| Web UI | `src/pages/RemoteControlPage.tsx`, route `/remote` in `src/App.tsx` |
| Hub menu | `src/lib/hubTools.ts` ("Remote Mac"), `HubCoverNav.tsx` footer link |
| Config | `supabase/config.toml` → `[functions.remote-bridge-api]` |

---

## Phase 0 — GitHub baseline

### 0.1 Merge or sync

```bash
cd /path/to/fendi-control-center
git fetch origin
git checkout main
git pull origin main
# If PR #12 is open:
gh pr merge 12 --merge   # or squash per team preference
git pull origin main
```

If merge conflicts on `telegram-webhook/index.ts`, resolve keeping **both** existing logic and the **Remote Mac** block before `createTaskRow` (search `tryHandleRemoteMacCommand`).

### 0.2 Verify frontend wiring on `main`

```bash
grep -E "RemoteControlPage|/remote" src/App.tsx src/lib/hubTools.ts
```

Expected:

- `import RemoteControlPage from "./pages/RemoteControlPage"`
- `<Route path="/remote" element={<RemoteControlPage />} />`
- `hubTools` entry `path: "/remote"`

---

## Phase 1 — Database

### 1.1 Apply migration

**Option A — Supabase SQL editor (Dashboard):**  
Paste and run the full contents of:

`supabase/migrations/20260602120000_remote_command_queue.sql`

**Option B — CLI (if linked):**

```bash
supabase db push
# or apply single file via migration workflow your team uses
```

### 1.2 Verify tables exist

```sql
SELECT COUNT(*) FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('remote_command_queue', 'remote_bridge_devices');

SELECT proname FROM pg_proc
WHERE proname = 'claim_remote_command_rows';
```

Expect: 2 tables, 1 function.

---

## Phase 2 — Supabase secrets

Set in **Dashboard → Project Settings → Edge Functions → Secrets** (or `supabase secrets set`).

| Secret | Required | How to generate / value |
|--------|----------|-------------------------|
| `REMOTE_BRIDGE_TOKEN` | **Yes** | `openssl rand -hex 32` — same value on Mac daemon |
| `REMOTE_BRIDGE_DEVICE_NAME` | No | e.g. `fendi-macbook` (default `primary-mac`) |
| `REMOTE_BRIDGE_ENQUEUE_KEY` | No | Optional extra enqueue auth |
| `FendiAIbot` | Yes (existing) | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Yes (existing) | Your operator chat id |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | Yes (existing) | High-entropy; not the bot token |

**Do not** commit secrets to git.

---

## Phase 3 — Deploy edge functions

Lovable **Publish** only updates the React app. You **must** deploy functions separately.

```bash
cd /path/to/fendi-control-center
supabase link --project-ref wkzwcfmvnwolgrdpnygc   # if not linked

supabase functions deploy remote-bridge-api
supabase functions deploy telegram-webhook
```

### 3.1 Smoke test `remote-bridge-api`

```bash
export SUPABASE_URL="https://wkzwcfmvnwolgrdpnygc.supabase.co"
curl -s -X POST "$SUPABASE_URL/functions/v1/remote-bridge-api" \
  -H "Content-Type: application/json" \
  -d '{"action":"health"}' | jq .
```

Expect JSON with `"ok": true` and `bridge_token_configured: true` after secret is set.

### 3.2 Re-register Telegram webhook (if secret changed or bot never worked)

Invoke once (Dashboard → Edge Functions → `setup-telegram-webhook` → Test), or:

```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/setup-telegram-webhook" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

Confirm `telegram_response.ok` is true.

---

## Phase 4 — Lovable / frontend deploy

1. Open Lovable project linked to `fendi-control-center`.
2. Confirm GitHub `main` includes Remote Control Hub commits.
3. **Publish** / deploy the web app.
4. Confirm production URL loads `/remote` (may redirect to login — expected).

**Frontend env (already standard):**

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

No new `VITE_*` vars are required for `/remote`.

---

## Phase 5 — Mac bridge daemon (operator machine)

On the Mac that should receive commands:

```bash
cd /path/to/fendi-control-center

export SUPABASE_URL="https://wkzwcfmvnwolgrdpnygc.supabase.co"
export REMOTE_BRIDGE_TOKEN="<same as Supabase secret>"
export REMOTE_BRIDGE_WORKDIR="$HOME/<your-projects-folder>"   # e.g. Control Hub parent dir
export REMOTE_BRIDGE_DEVICE_NAME="fendi-macbook"

# Keep running (tmux recommended):
node scripts/remote-bridge/run.mjs
```

**Optional — launchd (stay running after logout):** create `~/Library/LaunchAgents/com.fendi.remote-bridge.plist` pointing at the script + env file; `launchctl load` it. (Claude can draft plist if user wants.)

**CLI prerequisites on Mac:**

| Command type | Needs on PATH |
|--------------|----------------|
| `shell` | `/bin/bash` |
| `cursor_agent` | `cursor` CLI with `agent` subcommand |
| `claude` | Anthropic `claude` CLI |
| `open_url` / `notify` | macOS |

---

## Phase 6 — End-to-end verification

Run in order. **Stop and fix** if any step fails.

| # | Test | Expected |
|---|------|----------|
| 1 | Mac daemon running | Console: `Remote bridge starting` |
| 2 | `curl` health (Phase 3.1) | `bridge_token_configured: true` |
| 3 | Telegram: `/mac status` | `Bridge: online`, recent `last_seen` |
| 4 | Telegram: `/mac pwd` or `/mac git status` | Queued then stdout reply on Telegram |
| 5 | Browser: log in → `/remote` | Bridge status badge **Mac online** |
| 6 | Web: queue `shell` → `echo hello` | Row completes; output visible in Recent commands |
| 7 | Telegram: `/ping` | `pong` (legacy bot health) |

### SQL spot-check (optional)

```sql
SELECT id, command_type, status, created_at, completed_at
FROM remote_command_queue
ORDER BY created_at DESC
LIMIT 10;
```

---

## Phase 7 — Telegram reliability (if bot still flaky)

Remote bridge is independent; fix the main bot in parallel:

1. `telegram-webhook` deployed (Phase 3).
2. `TELEGRAM_CHAT_ID` matches the chat you message from.
3. `TELEGRAM_WEBHOOK_SECRET_TOKEN` set; `setup-telegram-webhook` re-run.
4. Cron or manual runs of `telegram-outbox-flush` for stuck messages.
5. Ops page `/ops` — inspect `telegram_outbox` for `failed` rows.

---

## Definition of done

- [ ] PR #12 merged to `main`
- [ ] Migration applied; `claim_remote_command_rows` exists
- [ ] `remote-bridge-api` + `telegram-webhook` deployed
- [ ] `REMOTE_BRIDGE_TOKEN` set in Supabase and on Mac
- [ ] Mac daemon running continuously
- [ ] `/mac status` → online
- [ ] `/remote` enqueues and completes a test shell command
- [ ] User informed: hub menu → **Remote Mac** or URL `/remote`

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `/mac status` offline | Daemon not running or wrong token | Start `run.mjs`; match `REMOTE_BRIDGE_TOKEN` |
| Enqueue failed from Telegram | `remote-bridge-api` not deployed | `supabase functions deploy remote-bridge-api` |
| `/remote` 404 | Frontend not deployed or old build | Lovable publish; confirm `App.tsx` route |
| `/remote` enqueue 401 | Not logged in | Sign in via `/login` |
| Command stuck `queued` | Mac offline | Start daemon |
| `cursor_agent` fails | CLI missing | Install Cursor CLI; verify `cursor agent --help` |
| Telegram 403 | Wrong chat or webhook secret | Fix `TELEGRAM_CHAT_ID` / re-run setup webhook |
| Health shows token not configured | Secret missing | Set `REMOTE_BRIDGE_TOKEN` in Supabase |

---

## Files Claude should read if debugging

1. `docs/REMOTE_CONTROL_HUB.md`
2. `supabase/functions/remote-bridge-api/index.ts`
3. `supabase/functions/_shared/remoteBridgeTelegram.ts`
4. `scripts/remote-bridge/run.mjs`
5. `src/pages/RemoteControlPage.tsx`

---

## Out of scope for this handoff

- Multi-Mac device registry UI
- Shell command approval workflow
- Fixing unrelated tax PDF pipeline (see `cursor-directive-fix-everything.md`)
- Fairway / taxgenerator cross-project deploys

---

## Report back to the human

When finished, send a short status:

1. PR merge SHA on `main`
2. Migration applied (yes/no)
3. Functions deployed (list)
4. `/mac status` result (online/offline)
5. `/remote` test result
6. Anything blocked (credentials, CLI missing, etc.)
