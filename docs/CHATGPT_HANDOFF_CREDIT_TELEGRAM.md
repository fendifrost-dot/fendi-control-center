# Handoff: Fendi Control Center — Credit / Telegram / Drive / Credit Guardian

**Audience:** ChatGPT (or any engineer) picking up this work.  
**Repo:** `fendi-control-center` (Telegram bot, Supabase Edge Functions, Drive ingest).  
**Related app:** `fairway-fixer-18` — Credit Guardian / Credit Compass (Lovable); exposes `cross-project-api` / `control-center-api` with shared handler `creditGuardianApi.ts`.

**Deployment note:** Supabase migrations and Edge Function deploys are done **through Lovable** by the owner, not assumed from local CLI.

---

## What we implemented

### 1. Credit Guardian client resolution (`analyze-credit-strategy`)

**File:** `supabase/functions/analyze-credit-strategy/index.ts`

- Fairway’s `get_clients` returns `legal_name` / `preferred_name`, not `name`. Matching previously used `c.name` and effectively never matched CG.
- **Fix:** Use `name ?? legal_name ?? preferred_name` (`cgDisplayName`), normalize names (e.g. strip trailing `04.10`-style dates), try normalized name first.

### 2. Telegram: autonomous credit routing (no required `/do`)

**Files:** `supabase/functions/telegram-webhook/index.ts`, `supabase/functions/_shared/creditDecisionEngine.ts`

- **Decision engine:** Regex-first mapping to workflows: `analyze_credit_strategy`, `credit_analysis_and_disputes`, `drive_ingest`; confidence gate via `shouldAutoExecuteCreditIntent`.
- **`resolveAutoCreditWorkflow`:** Auto-promotes Lane 1 for natural language without `/do`.
- **`SYNTHETIC_DRIVE_INGEST`:** `drive_ingest` workflow with `ingest_drive_clients` tool; synthetic registry fallback in `executeAgenticLoop`.
- **Deterministic client extraction:** `extractClientNameForDriveCommand` for ingest; credit command regex allows plural “credit reports.”
- **Lane 2 prompt:** Stopped telling users to use slash commands for credit; states that credit tasks auto-execute when described.

### 3. Case memory schema (SQL only — apply in Lovable)

**File:** `supabase/migrations/20260411120000_credit_case_memory.sql`

- `credit_case_profiles` — Hub `client_id`, optional `cg_client_id`, `case_phase`, `memory_summary` / `memory_json`
- `credit_report_snapshots` — dated structured pulls for time-series compare
- `credit_dispute_outcomes` — deleted / verified / reinserted / etc.

**Helper:** `formatCaseMemorySnippet` in `creditDecisionEngine.ts` — not yet wired into live prompts (future “memory injection”).

### 4. Drive ingest: dedicated credit root folder

**Files:** `supabase/functions/_shared/driveFolderPolicy.ts`, `supabase/functions/ingest-drive-clients/index.ts`

- **Previous behavior:** Only subfolders whose **name contained the word `CREDIT`** were ingested. Folders like **“Zeus”** or **“Jabril”** were **skipped**, so Drive files never reached Credit Guardian.
- **Fix:** Env **`DRIVE_CREDIT_ROOT_IS_DEDICATED`** (`true` / `1`). When set, all direct subfolders under `DRIVE_FOLDER_ID` are treated as credit clients **except** ambiguous tax+credit names and tax-labeled folders (`shouldIngestCreditSubfolder`).
- **Intent patterns:** “Add … to credit guardian” etc. map toward `drive_ingest` in `creditDecisionEngine.ts`.
- **`client_name` filter:** Matches substrings on the **Drive folder name**. If the folder is **“Zeus”** but the user says “Jabril,” passing `client_name: "jabril"` matches **nothing** — use **`zeus`** (or omit `client_name` to scan all eligible folders).
- **Ingest JSON:** Responses include **`ingest_diagnostics`** (skip counts, sample folder names) and often a **`hint`** when zero clients were processed (wrong root, missing `DRIVE_CREDIT_ROOT_IS_DEDICATED`, or name filter mismatch).

### 5. Documentation

**File:** `.env.example` — comments for `DRIVE_FOLDER_ID`, `Google_Cloud_Key`, `DRIVE_CREDIT_ROOT_IS_DEDICATED`.

### 6. Unified Client Intelligence Layer (credit)

**Files:** `supabase/functions/_shared/unifiedClientIntelligence.ts`, `telegram-webhook` (`executeAgenticLoop`)

- Resolves a client name across **Hub** (`fuzzyClientSearch`), **Credit Guardian** (`get_clients`, `get_client_detail`, `get_documents`), and **Drive** (subfolders of `DRIVE_FOLDER_ID`).
- Emits **recommended next action** (e.g. `ingest_drive`, `run_guardian_analysis`, `generate_disputes`, `generate_rebuttal`) from heuristics — does **not** remove or replace existing workflows; **augments** `docContext` for credit workflows so the model is state-aware.

### Git commits (local `main`; push/rebase with `origin` as needed)

- `7f8d416` — CG name resolution, autonomous routing, case memory migration, `creditDecisionEngine.ts`
- `6e142d8` — Dedicated credit root + drive ingest policy + “add to CG” intents
- `85d8c1e` — Unified Client Intelligence layer (Hub + CG + Drive grounding in agentic loop)

---

## Architecture (short)

| Piece | Role |
|--------|------|
| **Telegram** `telegram-webhook` | Routes Lane 1 (execute) vs Lane 2 (assistant); auto-promotes credit intents. |
| **`ingest-drive-clients`** | Lists **`DRIVE_FOLDER_ID`** subfolders → reads PDFs/docs → extracts events → **`import_timeline_events`** to Fairway. |
| **`analyze-credit-strategy`** | CG `get_client_detail` + `get_documents` → Claude JSON strategy (does **not** sync Drive by itself). |
| **`query_credit_guardian`** | Read-only CG API (`get_clients`, etc.) — **Fairway DB**, not Google Drive. |
| **`drive-sync`** | Tax-oriented; filters **TAX** folder names — **not** the credit ingest path. |

---

## Issues / gaps (current)

1. **Jabril / client not in CG until ingest succeeds**  
   If the client doesn’t exist in Fairway or no events were imported, analysis and queries look empty or generic.

2. **Lane 2 has no Drive API**  
   Assistant mode cannot “see” Zeus/Jabril folders; only **`ingest_drive_clients`** touches Drive. Users may expect the bot to “look in Drive” from chat without running ingest.

3. **`DRIVE_FOLDER_ID` and secrets must be correct in Lovable**  
   Owner should set folder id (e.g. credit root `…/folders/1oXP20VuoEy8MvDj-EtabrgJQZooemghi`) and **`DRIVE_CREDIT_ROOT_IS_DEDICATED=true`** if subfolders are plain names without “CREDIT.”

4. **Case memory tables**  
   Migration may not be applied yet; no automatic writes to `credit_case_profiles` / snapshots — **stateless-ish** replies until wired.

5. **Multi-step pipeline not chained**  
   Ideal flow “ingest Drive → then analyze” may still be two user steps unless orchestration is added.

6. **Branch divergence**  
   Local `main` may have diverged from `origin/main`; reconcile before push.

7. **`query_credit_compass` vs Bearer**  
   Documented elsewhere: Bearer vs `x-api-key` mismatch can 401 if not aligned with Fairway deployment.

---

## Suggested next steps for the next session

1. Apply migration `20260411120000_credit_case_memory.sql` in Lovable; redeploy **`telegram-webhook`**, **`ingest-drive-clients`**, **`analyze-credit-strategy`**.
2. Set secrets: **`DRIVE_FOLDER_ID`**, **`DRIVE_CREDIT_ROOT_IS_DEDICATED=true`**, **`Google_Cloud_Key`**.
3. Smoke test: run **`ingest_drive_clients`** with `client_name` matching a subfolder (e.g. zeus/jabril), confirm Fairway client/timeline.
4. Optionally: inject `formatCaseMemorySnippet` into `buildConversationContext` / agentic system prompt when a Hub client resolves.
5. Optionally: single workflow that chains **`ingest_drive_clients`** → **`analyze_credit_strategy`** for a named client.

---

## Key file references

```
supabase/functions/telegram-webhook/index.ts
supabase/functions/ingest-drive-clients/index.ts
supabase/functions/analyze-credit-strategy/index.ts
supabase/functions/_shared/creditGuardian.ts
supabase/functions/_shared/creditDecisionEngine.ts
supabase/functions/_shared/unifiedClientIntelligence.ts
supabase/functions/_shared/driveFolderPolicy.ts
supabase/migrations/20260411120000_credit_case_memory.sql
docs/FAIRWAY_FIXER_INTEGRATION.md (CG API contract)
```

---

*End of handoff.*
