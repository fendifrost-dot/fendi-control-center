# Prompt for Claude — Fendi Control Hub / Fairway / Lovable

For **full system context, git state, and prioritized next steps**, read **`docs/CLAUDE_COMPREHENSIVE_ONBOARDING.md`** in this repo (or **`CLAUDE_COMPREHENSIVE_ONBOARDING.md`** in `Documents/Claude/Projects/Control Hub/` on the Mac).

Use this file as the **short system or task preamble** when you want Claude to continue work on these projects with correct repo boundaries and deploy flow.

---

## Repos (GitHub org: `fendifrost-dot`)

| Repo | Lovable / product | What to edit |
|------|-------------------|--------------|
| `fendi-control-center` | Control Center (Telegram, orchestration) | `supabase/functions/*`, especially `telegram-webhook`, `_shared/creditGuardian.ts` |
| `fairway-fixer-18` | **Credit Guardian** + **Credit Compass** (same app; Lovable may show Credit Compass after rename) | App + `supabase/functions/*`, `PROJECT_CONTEXT.md` at **repo root** |
| `fendi-fight-plan` | Legacy / optional — only if you still maintain a separate repo | Was previously confused with Credit Compass; **Credit Compass = fairway-fixer-18** now |
| `taxgenerator` | CC Tax | `supabase/functions/control-center-api` |

**FanFuel / playlists** use env `FANFUEL_HUB_URL` — a **separate** Supabase project.

**`control-center-api` name collision:** CC Tax and (legacy) other apps each expose their own function name. **Fairway** deploys `cross-project-api` and **`control-center-api` as the same handler** (`x-api-key`). See the full audit doc for Bearer vs `x-api-key` on `query_credit_compass`.

---

## Pushing to GitHub (credentials required)

Automated pushes may fail with `Authentication failed`. Run from **your Mac** (where `gh` or GitHub credentials work):

**Option A — Docs-only PR (clean, matches current `origin/main`):** a branch **`handoff/claude-docs`** was created with at least:

- `docs/CLAUDE_HANDOFF_PROMPT.md`
- `docs/CLAUDE_COMPREHENSIVE_ONBOARDING.md` (add via merge/cherry-pick from `main` if not on that branch yet)
- `docs/fairway-fixer-18/PROJECT_CONTEXT.md`

```bash
cd /path/to/fendi-control-center
git fetch origin
git checkout handoff/claude-docs
git push -u origin handoff/claude-docs
```

Open GitHub → **Compare & pull request** → `handoff/claude-docs` into `main` → merge.

**Option B — Your local `main`** includes these docs plus optional comment edits in `creditGuardian.ts` / `telegram-webhook` (see `git log`). If your `main` has diverged from `origin/main`, **merge or rebase** with remote first, resolve conflicts, then `git push origin main`.

---

## After you change code

1. **Commit and push to GitHub** (`main` or the default branch):

   ```bash
   cd /path/to/fendi-control-center   # or fairway-fixer-18, etc.
   git status
   git add <files>
   git commit -m "Clear sentence describing the change."
   git push origin main
   ```

2. **Lovable:** Open the project linked to that GitHub repo; confirm the new commit synced; let the app **build/deploy** if required.

3. **Supabase edge functions:** Deploy changed functions from Lovable’s Cloud/Supabase UI or:

   ```bash
   supabase functions deploy <function-name>
   ```

4. **Secrets:** Only in the Supabase/Lovable dashboard for each project — never commit tokens.

---

## Fairway `PROJECT_CONTEXT.md` sync (important)

The audited edge-function table for Fairway lives in **two** places that must stay identical:

- **Canonical in Control Center repo:** `fendi-control-center/docs/fairway-fixer-18/PROJECT_CONTEXT.md`
- **Live in Fairway repo:** `fairway-fixer-18/PROJECT_CONTEXT.md` (repo root)

If you only have access to **fendi-control-center** in an agent session, commit the `docs/fairway-fixer-18/PROJECT_CONTEXT.md` file there, then **copy its contents** into `fairway-fixer-18` on GitHub (web editor or local clone) and commit on **fairway-fixer-18**.

**One-line instruction for Claude:**

> Copy `docs/fairway-fixer-18/PROJECT_CONTEXT.md` from `fendifrost-dot/fendi-control-center` to `PROJECT_CONTEXT.md` at the root of `fendifrost-dot/fairway-fixer-18`, commit, push, then confirm Lovable picked up the commit for the Credit Guardian / Credit Compass app.

---

## Full audit reference (local path on user’s Mac)

`Documents/Claude/Projects/Control Hub/FENDI_CONTROL_HUB_FULL_AUDIT_2026-03-29.md`

---

## Constraints for agents

- **Credit Compass** is the **fairway-fixer-18** project (rebranded / display name); do not confuse with **FanFuel** (`FANFUEL_HUB_URL`).
- Default CG endpoint from Control Center is **`cross-project-api`**; Fairway also deploys **`control-center-api`** as an alias on the **same** CG project.
- Workflow count in the bot is **`IMPLEMENTED_WORKFLOW_KEYS.size`** — never hardcode a fixed number in documentation.
