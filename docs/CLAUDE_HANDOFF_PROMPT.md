# Prompt for Claude — Fendi Control Hub / Fairway / Lovable

Use this as the **system or task preamble** when you want Claude to continue work on these projects with correct repo boundaries and deploy flow.

---

## Repos (GitHub org: `fendifrost-dot`)

| Repo | Lovable / product | What to edit |
|------|-------------------|--------------|
| `fendi-control-center` | Control Center (Telegram, orchestration) | `supabase/functions/*`, especially `telegram-webhook`, `_shared/creditGuardian.ts` |
| `fairway-fixer-18` | Credit Guardian (Fairway Fixer) | App + `supabase/functions/*`, `PROJECT_CONTEXT.md` at **repo root** |
| `fendi-fight-plan` | Credit Compass (not FanFuel) | `supabase/functions/control-center-api` |
| `taxgenerator` | CC Tax | `supabase/functions/control-center-api` |

**FanFuel / playlists** use env `FANFUEL_HUB_URL` — a **separate** Supabase project, not the fight-plan repo.

**Three different `control-center-api` functions** exist on three projects; auth differs (`x-api-key` vs Bearer). See `Documents/Claude/Projects/Control Hub/FENDI_CONTROL_HUB_FULL_AUDIT_2026-03-29.md` on this machine for the full map.

---

## Pushing to GitHub (credentials required)

Automated pushes may fail with `Authentication failed`. Run from **your Mac** (where `gh` or GitHub credentials work):

**Option A — Docs-only PR (clean, matches current `origin/main`):** a branch **`handoff/claude-docs`** was created with only:

- `docs/CLAUDE_HANDOFF_PROMPT.md`
- `docs/fairway-fixer-18/PROJECT_CONTEXT.md`

```bash
cd /path/to/fendi-control-center
git fetch origin
git checkout handoff/claude-docs
git push -u origin handoff/claude-docs
```

Open GitHub → **Compare & pull request** → `handoff/claude-docs` into `main` → merge.

**Option B — Your local `main` already includes** commit `eca2059` (same docs + small comments in `creditGuardian.ts` / `telegram-webhook`). If your `main` has diverged from `origin/main`, **merge or rebase** with remote first, resolve conflicts, then `git push origin main`.

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

> Copy `docs/fairway-fixer-18/PROJECT_CONTEXT.md` from `fendifrost-dot/fendi-control-center` to `PROJECT_CONTEXT.md` at the root of `fendifrost-dot/fairway-fixer-18`, commit, push, then confirm Lovable picked up the commit for Credit Guardian.

---

## Full audit reference (local path on user’s Mac)

`Documents/Claude/Projects/Control Hub/FENDI_CONTROL_HUB_FULL_AUDIT_2026-03-29.md`

---

## Constraints for agents

- Do not confuse **Credit Compass** (`fendi-fight-plan`) with **FanFuel** (`FANFUEL_HUB_URL`).
- Default CG endpoint from Control Center is **`cross-project-api`**; Fairway also deploys **`control-center-api`** as an alias on the **same** CG project.
- Workflow count in the bot is **`IMPLEMENTED_WORKFLOW_KEYS.size`** — never hardcode a fixed number in documentation.
