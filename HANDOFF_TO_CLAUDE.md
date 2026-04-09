# Handoff: Claude Orchestrator + Control Center (April 2026)

This document is for the next implementer (Claude Code, Cursor, or human). It summarizes **what was done**, **what the repo state is**, and **exact next steps**.

---

## 1. Goal (unchanged)

Replace Grok/Gemini as the **tool-orchestration brain** in the Telegram `telegram-webhook` with **Claude `tool_use` + multi-turn tool results**, then use Grok/Gemini only as **voice/formatters** for Telegram. Ground truth must come from **validated tool output**, not summarizer hallucinations.

**Source specs (user-provided):**

- `cursorhandoffclaudeorchestrator.md` — architecture and motivation  
- `cursordirectiveorchestratorbuild.md` — concrete file map and implementation steps  

**Canonical repo:** `~/fendi-control-center` (Lovable / Supabase edge functions). **Do not** put orchestrator logic in `taxgenerator-main` unless you are only wiring CC Tax API keys there.

---

## 2. What was executed (Cursor session)

### 2.1 Design / analysis

- Confirmed **control hub** is **`fendi-control-center`** (`supabase/functions/telegram-webhook/index.ts`, `_shared/*`).
- Noted gaps in the handoff doc: existing `callClaude` / `callClaudeJSON` do **not** implement `tool_use`; you must add **`callClaudeWithTools`** (or equivalent) with a **multi-turn** loop.
- Noted the codebase already had **Grok + Gemini** agentic paths; orchestration should be **Claude**, not “Grok-only.”

### 2.2 Implementation (later partially lost — see §3)

The following was **implemented in a working tree** per `cursordirectiveorchestratorbuild.md`:

| Deliverable | Intended location | Status now |
|-------------|-------------------|------------|
| `callClaudeWithTools()` multi-turn API | `supabase/functions/_shared/claude.ts` | **Not on `main`** — file ends after `callClaudeJSON`; must be re-added |
| `agenticClaudeCall()` + validation | `supabase/functions/_shared/orchestrator.ts` | **File exists locally but is untracked** — imports `callClaudeWithTools` from `claude.ts`, so it is **broken until `claude.ts` is extended** |
| Wire orchestrator + Grok/Gemini formatters + Done logic | `supabase/functions/telegram-webhook/index.ts` | **Not merged** — rebase/abort restored upstream `main` content for tracked files |
| Remove dead `getGeminiToolDeclarations` / `getGrokToolSchemas` if unused | `telegram-webhook/index.ts` | **Not on `main`** — do again if still unused after merge |

**Conflict resolution** (during git operations) applied the **466f065-style** fixes:

- `tax_return_id` line uses bullet `• Tax Return ID:` in `generate_tax_docs` summary text  
- “Done vs errors” uses **`hasToolErrors`** with explicit UTF-8 escapes for ❌ / ⚠️ where needed  
- `upsertTaxReturn` throws on SELECT error with template literal message  

### 2.3 Git: rebase + pull (what actually landed on `main`)

1. **`origin/main` was pulled with rebase:** `git pull --rebase origin main` (divergent branches; no default `pull.rebase` was set — use `--rebase` or configure).  
2. **Conflicts** appeared while replaying commit **`466f065`** (“fix: 5 pipeline bugs…”) onto newer `origin/main`.  
3. Conflicts were **resolved** in:
   - `supabase/functions/_shared/taxReturns.ts`
   - `supabase/functions/telegram-webhook/index.ts`
4. **`git rebase --continue`** completed with `GIT_EDITOR=true` (non-interactive).  

**Resulting local `main`:**

- **HEAD:** `04c88a4` — message: `fix: 5 pipeline bugs causing silent failure and fake success messages`  
- **Parent chain includes** the five fixes, e.g.:
  - `15d53c2` — telegram-webhook timeout 180s  
  - `b8bad25` — `upsertTaxReturn` SELECT error propagation  
  - earlier commits for Done-on-error, `tax_return_id` in tool output, HTTP handling, etc.  
- **Branch:** `main` is **`ahead` of `origin/main` by 1 commit** — the rebased replay of that fix commit.  
- **Push:** run `git push origin main` when ready to publish.

**Important:** A **`git rebase --abort`** at one point **reset tracked files** to a pre-rebase state; that is why the **orchestrator integration in `claude.ts` + `telegram-webhook/index.ts` did not survive on `main`**, while **`orchestrator.ts` remained as an untracked file** on disk.

---

## 3. Current repo facts (verify after clone/pull)

```bash
cd ~/fendi-control-center
git status -sb
git log --oneline -5
```

Expect:

- `main...origin/main [ahead 1]` until you push  
- Untracked: `supabase/functions/_shared/orchestrator.ts` (and possibly other local files)  
- `claude.ts`: **no** `callClaudeWithTools` until someone re-adds it  

---

## 4. Next steps (in order)

### A. Publish the rebased fix commit

```bash
cd ~/fendi-control-center
git push origin main
```

Then in **Lovable**: pull latest and **redeploy all edge functions** so production matches `04c88a4` and ancestors (timeouts, Done logic, `tax_return_id`, `upsertTaxReturn` behavior).

### B. Re-complete the orchestrator (required for the original product goal)

1. **Re-apply or re-implement** `callClaudeWithTools` in `_shared/claude.ts` per `cursordirectiveorchestratorbuild.md` (120s total budget, max rounds, `tool_result` loop).  
2. **Review untracked** `_shared/orchestrator.ts` — align with current `ToolDef` / `AGENT_TOOLS`; fix imports once `claude.ts` exports the helper.  
3. **Wire** `executeAgenticLoop` in `telegram-webhook/index.ts`: Claude orchestrates; Grok/Gemini format; structured Done using **validated** IDs.  
4. **Secrets:** `ANTHROPIC_API_KEY` (and optional `ANTHROPIC_MODEL`) in Lovable project settings.  
5. **Test** per directive: tax happy path (real `tax_return_id` + SQL check), bad client, non-tax tool, destructive confirmation.

### C. Optional cleanup

- If `orchestrator.ts` is correct, **`git add` + commit** with a clear message (e.g. `feat(telegram): Claude tool_use orchestrator + voice formatters`).  
- Remove any **duplicate** or obsolete helper functions only after confirming no callers.

---

## 5. Files to touch (reminder)

| Path | Action |
|------|--------|
| `supabase/functions/_shared/claude.ts` | Add `callClaudeWithTools` |
| `supabase/functions/_shared/orchestrator.ts` | Create or finish; ensure `agenticClaudeCall` matches webhook `ToolDef` |
| `supabase/functions/telegram-webhook/index.ts` | Import orchestrator; replace agentic Grok/Gemini **orchestration** block; keep formatters |

**Do not change** edge function bodies like `generate-tax-documents` unless a separate bug is filed — the directive scoped the fix to orchestration and reporting.

---

## 6. One-line summary for Claude

**`main` at `04c88a4` contains the rebased “5 pipeline bug” fixes and is 1 commit ahead of `origin/main` — push and deploy. The Claude `tool_use` orchestrator is not on `main`: only an untracked `orchestrator.ts` stub exists; re-implement `callClaudeWithTools` in `claude.ts`, wire `telegram-webhook`, then commit and deploy.**

---

*Generated for handoff. Update this file when orchestrator work is merged and pushed.*
