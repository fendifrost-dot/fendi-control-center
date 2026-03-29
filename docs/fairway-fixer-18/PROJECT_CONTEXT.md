# PROJECT_CONTEXT — fairway-fixer-18 (Credit Guardian / Credit Compass)

> **Mirror location:** `fendi-control-center/docs/fairway-fixer-18/PROJECT_CONTEXT.md`
> Keep both copies identical. If you edit one, copy to the other.

---

## Identity

- **GitHub repo:** `fendifrost-dot/fairway-fixer-18`
- **Product names:** **Credit Guardian** (original), **Credit Compass** (Lovable display/rebrand) — same codebase, same Supabase project.
- **Supabase project ID:** `gflvvzkiuleeochqcdeb`
- **Lovable project ID:** `f7f8be84-44ea-47da-b039-0c5ea8b28e2c`

---

## Edge Functions

| Function | Purpose | Auth | Called by |
|----------|---------|------|-----------|
| **`cross-project-api`** | Primary API for Control Center. Actions: `get_clients`, `get_client_detail`, `update_client_record`, `get_documents`, `get_recent_activity`, `import_timeline_events`. | `x-api-key` = `CREDIT_GUARDIAN_KEY` | Control Center (`telegram-webhook`, `ingest-drive-clients`) |
| **`control-center-api`** | Alias — **same Deno handler** as `cross-project-api` via `_shared/creditGuardianApi.ts` | `x-api-key` = `CREDIT_GUARDIAN_KEY` | Legacy callers (if any) |
| **`parse-with-ai`** | AI credit event parsing via Lovable gateway (Gemini) | JWT (validated internally) | App frontend |
| **`project-stats`** | Dashboard statistics for the operator console | None (public) | App frontend |
| **`run-probe`** | RLS diagnostic probes | JWT (forwarded) | App frontend (admin) |

### Shared module

`supabase/functions/_shared/creditGuardianApi.ts` — contains the unified handler for both `cross-project-api` and `control-center-api`. All actions route through here.

---

## Key Tables

| Table | Purpose |
|-------|---------|
| `clients` | Client records (`legal_name`, `preferred_name`, contact info) |
| `timeline_events` | Credit events per client. Columns: `id`, `client_id`, `event_date`, `category` (enum: Action/Note/Outcome/Response), `source` (enum: AG/BBB/CFPB/etc.), `title`, `summary`, `details`, `event_kind`, `date_is_unknown`, `raw_line`, `is_draft`, `related_accounts`, `created_at` |
| `documents` | Uploaded/linked documents per client |
| `tasks` | Open tasks for clients |
| `assessments` | Credit assessments |

### Enum types

- **`event_category`:** Action, Note, Outcome, Response
- **`event_source`:** AG, BBB, CFPB, ChexSystems, CoreLogic, Creditor, Equifax, EWS, Experian, FTC, Innovis, LexisNexis, NCTUE, Other, Sagestream, TransUnion

---

## Environment Variables (Supabase secrets)

- `CREDIT_GUARDIAN_KEY` — shared secret; must match what Control Center sends in `x-api-key` header
- `SUPABASE_SERVICE_ROLE_KEY` — admin DB access for edge functions
- `LOVABLE_API_KEY` — for `parse-with-ai` Gemini gateway

---

## Product Rules

1. **Credit Compass = this repo.** Do not create a separate repo or project for Credit Compass.
2. **Auth is `x-api-key`**, not Bearer, for cross-project calls from Control Center. The `query_credit_compass` tool in Control Center currently uses Bearer and may 401 — this is a known issue (see onboarding doc §3).
3. **`import_timeline_events`** is the action Control Center uses to push Drive-extracted events. It validates enums, handles null dates via `date_is_unknown`, and batch-inserts in groups of 50.
4. **Deploy via Lovable** after committing to GitHub. Code changes go through GitHub web editor, not Lovable.

---

## Recent Fixes (March 2026)

- **`import_timeline_events` action added** to `cross-project-api` (was missing entirely — broke Drive→CG pipeline)
- **Schema alignment** — removed non-existent columns (`confidence`, `source_file`, `drive_file_id`), added required NOT NULL fields (`date_is_unknown`, `raw_line`, `is_draft`), validated enum types
- Both fixes committed and deployed via Lovable

---

*Keep this file in sync with `fendi-control-center/docs/fairway-fixer-18/PROJECT_CONTEXT.md`.*
