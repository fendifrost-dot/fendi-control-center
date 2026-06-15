# Cursor / Claude Code handoff: raise daily email pitch cap in execute-pitch (CORRECTED FILE PATH)

## TL;DR

The earlier handoff pointed Cursor at the wrong file — `supabase/functions/control-center-api/index.ts`, which doesn't actually exist in the repo. The real cap-check lives in `supabase/functions/execute-pitch/index.ts` at line ~233. This handoff fixes the path and raises the cap from 10 to 30 per 24h. One file, two lines, push to main.

## Scope

- **Repo:** `fendifrost-dot/artistgrowthhub` (the Artist Growth Hub / Fan Fuel Hub repo)
- **File:** `supabase/functions/execute-pitch/index.ts`
- **Branch:** `main` (push directly, single-dev repo)
- **PAT in `~/fendi-control-center/.git/config` is EXPIRED** — use `gh` CLI auth (Fendi's `gh` is logged in as `fendifrost-dot` with `repo` + `workflow` scopes; this fallback worked for all AVT/CC pushes today including `1bc72d4`, `210fef2`, `a13b84e`).
- **No Lovable chat for code.** Chat is only for `redeploy edge function execute-pitch` after the push.
- **No schema changes.**

## Verification of the change point

Confirmed via `curl https://raw.githubusercontent.com/fendifrost-dot/artistgrowthhub/main/supabase/functions/execute-pitch/index.ts`:

```
233:  if (!capErr && (capCount ?? 0) >= 10) {
...
240:        `📧 Daily email pitch cap reached (10 per 24h across all tracks). Try again tomorrow.`,
```

The cap is calculated by counting `pitch_log` rows where `pitched_at >= now() - 24h` (line 231). The constant `10` appears in two places — the comparison and the error message string.

## The change

Two single-line edits in `supabase/functions/execute-pitch/index.ts`:

### Line ~233

**Before:**
```ts
  if (!capErr && (capCount ?? 0) >= 10) {
```

**After:**
```ts
  if (!capErr && (capCount ?? 0) >= 30) {
```

### Line ~240

**Before:**
```ts
        `📧 Daily email pitch cap reached (10 per 24h across all tracks). Try again tomorrow.`,
```

**After:**
```ts
        `📧 Daily email pitch cap reached (30 per 24h across all tracks). Try again tomorrow.`,
```

## What NOT to change

- **Don't touch the 24h window calculation** on line 231 — that's the correct rolling-24h logic.
- **Don't change the underlying count-from-pitch_log query.** It's correct as-is.
- **Don't introduce a config-table lookup or env variable.** Fendi asked for a quick bump from 10 → 30, not an architectural change. A future PR can promote this to `artist_config` if he wants per-artist tuning.
- **Don't touch any other edge function.** This change is isolated to `execute-pitch`.

## Discovery / verification before pushing

```bash
gh repo clone fendifrost-dot/artistgrowthhub /tmp/aghub-cap-fix
cd /tmp/aghub-cap-fix

# Confirm the line numbers + current values
grep -n "capCount ?? 0" supabase/functions/execute-pitch/index.ts
grep -n "Daily email pitch cap" supabase/functions/execute-pitch/index.ts

# Should show >= 10 and "(10 per 24h across all tracks)"
```

Then make the edits, verify diff is exactly 2 lines:

```bash
git diff supabase/functions/execute-pitch/index.ts
```

The diff should show ONLY the `10` → `30` swap in two places. Nothing else.

## Test plan after push

1. Push to `main` via `gh` CLI.
2. In Lovable chat for AGH project (`https://lovable.dev/projects/4778d2a5-781c-45e5-b165-9497cdba4918`), send EXACTLY:
   ```
   redeploy edge function execute-pitch
   ```
   Wait for "Done — `execute-pitch` redeployed successfully" (~20-30s). STOP if Lovable enters build/code mode.
3. Verify the cap is actually raised in production by hitting the Supabase REST API for `pitch_log` to see the recent activity, OR by triggering one pitch through the FFH UI / API and confirming it doesn't 429 with "Daily email pitch cap reached (10 per 24h)" — should now say 30 if cap fires, or just succeed if we're under 30.

## Hard rules

- **No Lovable chat for code edits.** Lovable chat is only for `redeploy edge function execute-pitch` after the push.
- **Use `gh` CLI** for push — the PAT in `.git/config` is expired (returns 401). `gh` CLI is the working fallback.
- **No schema changes.**
- **Match existing code style.** No reformat passes on adjacent lines.
- **Push to `main` directly.** Single-dev repo, no PR / branch workflow.

## Commit message

```
chore(aghub): raise daily email pitch cap from 10 to 30 per 24h

Fendi explicitly requested raising the cap so the daily 10-20 pitch
cadence target is reachable from inside the existing edge-function
guardrail. Two-line change in execute-pitch/index.ts:

- L233: capCount >= 10 → capCount >= 30
- L240: error message string updated to match

24h rolling window calculation unchanged. No schema changes. The cap
constant can be promoted to artist_config in a future PR if per-artist
tuning is needed.
```

## After this lands, orchestrator will:

1. Drive `redeploy edge function execute-pitch` via Lovable chat
2. Hit FFH frontend, re-enable anon sign-in if needed (it appears to be broken right now — the toggle in Lovable Cloud → Users → Auth settings may need flipping)
3. Fire the 6 queued batch3 pitches via `control-center-api` (Eskimo, Innervisions, Compost, Crack, Vinyl Factory, Dance Music NW) with the personalization angles already established
