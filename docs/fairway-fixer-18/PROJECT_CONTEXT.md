# Fairway Fixer — project context (for humans & Cursor)

> **Sync:** A duplicate used for GitHub sync from the Control Center repo lives at **`fendi-control-center/docs/fairway-fixer-18/PROJECT_CONTEXT.md`**. Keep this file and **`fairway-fixer-18/PROJECT_CONTEXT.md`** (repo root) in lockstep; see `fendi-control-center/docs/CLAUDE_HANDOFF_PROMPT.md`.

Forensic-grade **evidence ledger and operator console** for documenting credit-file disputes and bureau/data-furnisher correspondence. This is not a “credit repair bot”; the operator remains in control.

## Product philosophy
1. **Operator authority** — No automated recommendations, workflow auto-advancement, or AI interpretation that replaces judgment.
2. **Forensic ledger** — Timeline events are evidence; preserve provenance and ambiguity (`raw_line`, `date_is_unknown`).
3. **Transparent errors** — Null/invalid sources appear as placement issues; nothing is silently dropped.
4. **AI as assist only** — Parsing (`parse-with-ai`) and **Response Analyzer** letter drafting assist the operator; all outputs require review before sending.
5. **Source fidelity** — Evidence stays tied to its source (bureau, regulator, creditor bucket, etc.); no merged “all bureaus” views that obscure origin.
6. **Auditing** — Source corrections and client deletions should leave audit trails where the schema supports it.

## Stack
- Vite, React, TypeScript, Tailwind, shadcn/ui, TanStack Query, Supabase (auth + RLS + edge functions).

## Key files
| Area | Path |
|------|------|
| Domain types | `src/types/operator.ts` |
| DB-facing types | `src/types/database.ts` |
| Client workspace | `src/pages/ClientDetail.tsx` |
| Import engine | `src/components/operator/ChatGPTImport.tsx` |
| Evidence timeline | `src/components/operator/EvidenceTimeline/index.tsx` |
| Timeline CRUD + `raw_line` enforcement | `src/hooks/useTimelineEvents.ts` |
| Plain-text smart import | `src/lib/smartImport.ts` |
| Structured parser | `src/lib/parser/index.ts` |
| Auth | `src/contexts/AuthContext.tsx` |
| Cross-project API | `supabase/functions/cross-project-api/index.ts` (shared logic: `supabase/functions/_shared/creditGuardianApi.ts`) |
| Alias entrypoint | `supabase/functions/control-center-api/index.ts` — same behavior as `cross-project-api` for older hub URLs |
| AI parse assist | `supabase/functions/parse-with-ai/index.ts` |
| Bureau response → draft letter | `supabase/functions/analyze-bureau-response/index.ts` |
| Document text extraction (PDF/DOCX/image OCR) | `src/lib/responseDocumentExtract.ts` |
| Evidence bundling for analyzer | `src/lib/bureauResponseFacts.ts` |
| Analyzer UI | `src/components/operator/ResponseAnalyzerPanel.tsx` |

## Data rules
- `timeline_events.event_kind` (lowercase): `action` \| `response` \| `outcome` \| `note` \| `draft` (and drafts may use `is_draft`).
- `timeline_events.category`: PascalCase (`Action`, `Response`, `Outcome`, `Note`).
- Evidence timeline query excludes drafts and restricts `event_kind` to action/response/outcome/note.
- `Creditor` is a broad bucket; company names live in text fields, not the enum.
- `matters` → `clients` may lack an FK in DB; joins use explicit selects; TypeScript may use `as unknown` casts.

## Edge functions (summary)
| Function | Role |
|----------|------|
| `parse-with-ai` | Structure unrouted lines into timeline suggestions (JWT; default `verify_jwt` unless overridden in `supabase/config.toml`). |
| `analyze-bureau-response` | Combine masked bureau response text + ledger excerpts → draft letter JSON (`verify_jwt = true` in config). |
| `cross-project-api` / `control-center-api` | Same handler (`_shared/creditGuardianApi.ts`). Fendi Control Hub + Telegram; `x-api-key` === `CREDIT_GUARDIAN_KEY`. Service role — keep key secret. Actions include `import_timeline_events` (Drive ingest), `get_clients`, `get_client_detail`, etc. |
| `project-stats` | Dashboard stats; `verify_jwt = false`. |
| `run-probe` | RLS diagnostic: matters insert probe under the caller’s JWT (`verify_jwt` follows project defaults). |

## Client file URL tabs
- `/clients/:id` — Evidence & notes (default).
- `/clients/:id?tab=inbox` — Import & letters (deep link; shareable).

## Deploying the Response Analyzer edge function
From the repo root (with Supabase CLI logged in):

`supabase functions deploy analyze-bureau-response`

Requires the same `LOVABLE_API_KEY` secret as `parse-with-ai` (Lovable AI gateway).

## Testing
`npm test` / `npx vitest run` — parser, smart import, import routing, JSON import, regressions, deletion, bureau evidence helpers, etc.

## Guardrails (“what not to build”)
Automated dispute strategy, undisclosed AI decisions, CRM/sales features, aggregated cross-bureau views that hide source, or any feature that removes the operator from the loop.
