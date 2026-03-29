# Claude — Comprehensive Onboarding: Fendi Control Hub Ecosystem

**Purpose:** This document orients you on the full system, what has already been done (audits, docs, local commits), and **concrete next steps** you should take. The human has **not** sent prior context to Claude yet — treat this as the single source of truth to continue work.

**GitHub org:** `fendifrost-dot`

---

## 1. Executive summary

This is a **multi-repo, multi–Supabase-project** stack centered on **Fendi Control Center**: a **Telegram bot** (`telegram-webhook`) that orchestrates:

- **Credit Guardian / Credit Compass** — one product: the **fairway-fixer-18** repo and its Supabase project. **"Credit Compass"** is a **Lovable display / rebrand name**; it is **not** a separate codebase from Fairway Fixer / Credit Guardian.
- **CC Tax** — **taxgenerator** repo.
- **FanFuel (playlists / pitches)** — whatever Supabase project **`FANFUEL_HUB_URL`** points to (not the fight-plan repo).
- **Legacy / optional:** **`fendi-fight-plan`** — do **not** assume this is "Credit Compass"; earlier docs confused it with Compass. **Credit Compass = fairway-fixer-18.**

The bot uses **workflow keys**, **AI tool calling**, and **edge functions** across projects. Secrets live in **Supabase/Lovable** per project — never in git.

---

## 2. Repository map (what lives where)

| GitHub repo | Role |
|-------------|------|
| **`fendi-control-center`** | Control Center: Telegram `telegram-webhook`, Drive sync, document processing, ingest, notifications, shared helpers (`_shared/creditGuardian.ts` when present), docs under `docs/`. |
| **`fairway-fixer-18`** | Single Lovable app: operator console + **`cross-project-api`** and **`control-center-api`** (same handler: `_shared/creditGuardianApi.ts`). Drive→CG ingestion calls **`import_timeline_events`** here. Root **`PROJECT_CONTEXT.md`** documents edge functions and product rules. |
| **`taxgenerator`** | CC Tax: **`control-center-api`** edge function; bot uses **`query_cc_tax`** + **`CC_TAX_URL`** (and matching Bearer auth to tax project service role). |
| **`fendi-fight-plan`** | Legacy or optional second repo — **not** the canonical "Credit Compass" app; clarify with the human if still deployed. |

**FanFuel:** Configured only via **`FANFUEL_HUB_URL`** / **`FANFUEL_HUB_KEY`** (and optional **`FANFUEL_HUB_PLAYLIST_FN`**, default playlist edge name). Playlist research is **not** implemented inside `fendi-fight-plan` in the current mental model.

---

## 3. Why "three `control-center-api`" names appear

Different Supabase projects each expose an edge function **literally named** `control-center-api`. They are **not** interchangeable:

| Project | Typical URL segment | Auth |
|---------|---------------------|------|
| **Fairway (CG / Compass)** | `/functions/v1/cross-project-api` (default from Control Center) **or** `/functions/v1/control-center-api` (alias, **same** Deno handler) | **`x-api-key`** = `CREDIT_GUARDIAN_KEY` |
| **CC Tax** | `/functions/v1/control-center-api` | **Bearer** = tax project service role |
| **FanFuel** (if used) | May use another function name or Hub-specific `control-center-api` | Per FanFuel deployment |

**Important bug-avoidance:** Control Center's **`query_credit_guardian`** uses **`fetchCreditGuardian()`** → **`x-api-key`**. The **`query_credit_compass`** tool still calls **`/functions/v1/control-center-api`** with **`Authorization: Bearer`**. Fairway's deployed handler only validates **`x-api-key`**. If **`CREDIT_COMPASS_URL`** points at the **same** Fairway host as **`CREDIT_GUARDIAN_URL`**, **`query_credit_compass` may return 401** until implementation or secrets are aligned (e.g. refactor tool to use `fetchCreditGuardian`, or extend the edge function to accept Bearer for that path — product decision). Inline comments were added in **`telegram-webhook`** and **`creditGuardian.ts`** describing this.

---

## 4. What prior work already established

- **Drive → Credit Guardian pipeline:** Fixes included implementing **`import_timeline_events`** in Fairway's **`creditGuardianApi`**, correct CG endpoint from Control Center (**`cross-project-api`** default), and schema-aligned timeline inserts (**`date_is_unknown`**, **`raw_line`**, enums, etc.). Details appear in older audit notes (`fendi_control_hub_audit_report.md` in Control Hub folder).
- **Telegram webhook:** Prior fixes included **`sendMessage`** vs undefined **`sendTelegram`**, **`lowerText`**, **`messageText`/`text`** — may already be on **`origin/main`**; local branches can still diverge.
- **Documentation pass:** Full system map, Claude handoff prompt, Fairway **`PROJECT_CONTEXT`** mirror under **`fendi-control-center/docs/fairway-fixer-18/`**, rename clarification (**Credit Compass = fairway-fixer-18**).

---

## 5. Current git situation (Control Center repo — typical local state)

On the human's machine, **`fendi-control-center`** **`main`** has often been **ahead of `origin/main`** with multiple local commits **and** **behind** `origin/main` with many remote commits — branches have **diverged**. That means:

- **Do not** assume `git pull` is trivial; you may need **merge** or **rebase** and conflict resolution on **`telegram-webhook`**, **`ingest-drive-clients`**, etc.

A **docs-only** branch **`handoff/claude-docs`** was created from **`origin/main`** at one point, adding:

- `docs/CLAUDE_HANDOFF_PROMPT.md`
- `docs/fairway-fixer-18/PROJECT_CONTEXT.md`

(with later cherry-picks for push instructions). **Pushing from automated environments failed** (no GitHub token); the human must **`git push`** from a machine with credentials.

**Recent local commits on `main` (examples):** docs for Credit Compass rename, `query_credit_compass` comments, migration copy update, `CLAUDE_HANDOFF_PROMPT` / `PROJECT_CONTEXT` mirror updates — see **`git log`** on the human's clone.

---

## 6. Key files you should read first

| Path | Why |
|------|-----|
| `fendi-control-center/docs/CLAUDE_HANDOFF_PROMPT.md` | Short operational prompt: repos, push options, Fairway sync one-liner. |
| `fendi-control-center/docs/CLAUDE_COMPREHENSIVE_ONBOARDING.md` | **This full onboarding** (duplicate of Control Hub folder copy). |
| `fendi-control-center/docs/fairway-fixer-18/PROJECT_CONTEXT.md` | Mirror of Fairway root context — edge function list and product rules. |
| `fairway-fixer-18/PROJECT_CONTEXT.md` | Should match the mirror (same repo, human's disk). |
| `fairway-fixer-18/supabase/functions/_shared/creditGuardianApi.ts` | **`import_timeline_events`**, CG actions, auth. |
| `fendi-control-center/supabase/functions/_shared/creditGuardian.ts` | **`fetchCreditGuardian`** URL + default **`cross-project-api`**. |
| `fendi-control-center/supabase/functions/telegram-webhook/index.ts` | **`query_credit_guardian`**, **`query_credit_compass`**, **`query_cc_tax`**, FanFuel helpers, **`IMPLEMENTED_WORKFLOW_KEYS`**. |
| `Documents/Claude/Projects/Control Hub/FENDI_CONTROL_HUB_FULL_AUDIT_2026-03-29.md` | Longer audit + handoff (paths on Mac). |

---

## 7. Environment variables (Control Center edge functions — high level)

- **`CREDIT_GUARDIAN_URL`**, **`CREDIT_GUARDIAN_KEY`** — Fairway CG API; optional **`CREDIT_GUARDIAN_FUNCTION`** (default **`cross-project-api`**).
- **`CREDIT_COMPASS_URL`**, **`CREDIT_COMPASS_KEY`** — Intended for "Credit Compass"; if same project as Fairway, align with reality and **`query_credit_compass`** auth (see §3).
- **`CC_TAX_URL`** and tax key usage as implemented in **`query_cc_tax`**.
- **`FANFUEL_HUB_URL`**, **`FANFUEL_HUB_KEY`**, optional **`FANFUEL_HUB_PLAYLIST_FN`**.
- Standard bot/AI: **`FendiAIbot`**, **`TELEGRAM_CHAT_ID`**, **`Frost_Gemini`**, **`Frost_Grok`**, Drive keys, etc.

---

## 8. Your next steps (prioritized)

Do these in order unless the human directs otherwise.

### A. Establish a clean GitHub baseline

1. On a machine with **GitHub auth**, **`cd`** into **`fendi-control-center`**.
2. **`git fetch origin`** and inspect **`git log main`** vs **`origin/main`**.
3. Either:
   - **Merge or rebase** local **`main`** onto **`origin/main`**, resolve conflicts, then **`git push origin main`**, **or**
   - Open a **PR** from **`handoff/claude-docs`** into **`main`** to land docs-only changes, then merge remaining work in follow-up PRs.
4. **Push any branch** that only contains documentation if the human prefers small PRs.

### B. Land documentation on GitHub

- Ensure **`docs/CLAUDE_HANDOFF_PROMPT.md`**, **`docs/CLAUDE_COMPREHENSIVE_ONBOARDING.md`**, and **`docs/fairway-fixer-18/PROJECT_CONTEXT.md`** exist on **`main`** after merges.
- Keep **`Documents/Claude/Projects/Control Hub/`** copies in sync if the human uses them as offline copies (optional; not required for CI).

### C. Sync Fairway repo `PROJECT_CONTEXT.md`

- Copy content from **`fendi-control-center/docs/fairway-fixer-18/PROJECT_CONTEXT.md`** to **`fairway-fixer-18`** repo root **`PROJECT_CONTEXT.md`** on GitHub if not already identical.
- Commit on **`fairway-fixer-18`** and let **Lovable** sync.

### D. Resolve `query_credit_compass` vs Fairway auth (recommended follow-up)

- If **`CREDIT_COMPASS_URL`** === Fairway: implement **one** of:
  - Refactor **`query_credit_compass`** to use **`fetchCreditGuardian`** with a **mapped action set** (may require parity with tool enums vs **`creditGuardianApi`** actions), **or**
  - Add **Bearer** validation alongside **`x-api-key`** in Fairway's handler (security review required), **or**
  - Deprecate **`query_credit_compass`** and document **`query_credit_guardian`** only.
- Redeploy **`telegram-webhook`** after changes.

### E. Lovable / Supabase deploy

- After GitHub is current, trigger or verify **Lovable** build/deploy for **Control Center** and **Fairway** as needed.
- **Redeploy edge functions** that changed (e.g. **`telegram-webhook`**, **`cross-project-api`**).

### F. Smoke tests

- Telegram: **`/status`**, **`/workflows`**, a **Credit Guardian** query, **CC Tax** if configured, **playlist** flow if FanFuel env is set.
- Optional: **"sync drive"** / **"ingest drive"** for full Drive → **`import_timeline_events`** path.

### G. Optional cleanup

- Confirm whether **`fendi-fight-plan`** is archived or still needed; update docs if retired.
- Reconcile **`artistgrowthhub`** or other stale repos per product owner.

---

## 9. Constraints for implementation

- Prefer **minimal, focused diffs**; match existing style and patterns.
- **Do not** commit secrets.
- **Workflow count** in code is **`IMPLEMENTED_WORKFLOW_KEYS.size`** — do not hardcode outdated counts in docs.
- **Credit Compass** naming: **fairway-fixer-18**; do not route new work to **`fendi-fight-plan`** unless the human confirms it is still active.

---

## 10. One-paragraph paste for a short Claude session

*You are continuing work on the Fendi Control Hub: GitHub **`fendifrost-dot`**. Control Center is **`fendi-control-center`** (Telegram bot). Credit Guardian and Credit Compass are the **same** app — **`fairway-fixer-18`** (Lovable may show "Credit Compass"). CC Tax is **`taxgenerator`**. FanFuel uses **`FANFUEL_HUB_URL`**. CG API uses **`x-api-key`** to **`cross-project-api`**; **`query_credit_compass`** still uses Bearer and may 401 against Fairway — fix or consolidate. Local **`main`** may be **diverged** from **`origin/main`**; **`git fetch`**, merge/rebase, push. Land **`docs/CLAUDE_HANDOFF_PROMPT.md`**, **`docs/CLAUDE_COMPREHENSIVE_ONBOARDING.md`**, and **`docs/fairway-fixer-18/PROJECT_CONTEXT.md`**, sync Fairway **`PROJECT_CONTEXT.md`**, deploy **`telegram-webhook`** / Fairway functions via Lovable, then smoke-test Telegram. Full detail: **`docs/CLAUDE_COMPREHENSIVE_ONBOARDING.md`** in **`fendi-control-center`** (same as **`CLAUDE_COMPREHENSIVE_ONBOARDING.md`** in the Control Hub folder on the Mac).*

---

*Document generated for handoff; update dates and commit hashes when the repo state changes.*
