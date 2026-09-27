# Muse — executive layer inside Control Hub

Muse is the executive intelligence / Chief of Staff layer **inside** the existing
Fendi Control Hub. It is not a new application and not a new system of record.

```
Fendi
  → Control Hub            (orchestration / control plane — unchanged)
    → Muse executive layer (interpretation, references, state, decisions)
      → domain agents/systems
        → authoritative sources
```

Domain systems keep ownership of truth. Muse stores executive *interpretation*:
open loops, decisions, source authority, conflicts, improvements, verification
state. Operational facts are read live, never copied.

---

## 1. Control Hub inspection (what was found before building)

### A. Current architecture

| Layer | What exists |
|---|---|
| Frontend | Vite + React 18 + React Router + shadcn/ui + Tailwind, `src/App.tsx` routes |
| Auth | Supabase email/password session; `RequireSession` guards routed subtrees |
| Data | One Supabase project (Lovable Cloud) `wkzwcfmvnwolgrdpnygc`, 34 live tables |
| Backend | ~50 Supabase edge functions under `supabase/functions/` |
| Agent framework | `tasks` / `sessions` / `workflows` / `workflow_runs` / `tool_execution_logs`, driven by `telegram-webhook` |
| Audit/logging | `audit_logs`, `tax_return_audit_log`, `tool_execution_logs`, `drive_sync_events` |
| Nav convention | `HUB_TOOL_DEFS` in `src/lib/hubTools.ts` feeds both the cover menu and the tool grid |
| Shell convention | `TaxShell` — sticky header, Home link, section nav, email, sign-out, theme toggle |
| Deploy | Code to GitHub `main`; SQL via **Lovable SQL editor**; frontend via **Lovable Publish**; functions via **Lovable Edge Functions → redeploy** |

### B. What Muse reuses (nothing rebuilt)

* The existing Supabase project, client (`src/integrations/supabase/client.ts`) and session.
* `RequireSession` for auth — Muse adds no new login, role table or credential for the UI.
* The `TaxShell` layout conventions, reproduced as `MuseShell`.
* `HUB_TOOL_DEFS` for navigation — Muse is one more internal tile.
* shadcn primitives already in `src/components/ui` (49 components); no new UI dependency.
* `@tanstack/react-query`, whose provider is already mounted in `App.tsx`.
* The edge-function conventions of `remote-bridge-api` (own token header, `verify_jwt = false`, service-role client server-side only).
* The existing operational tables as the live telemetry source for agent health.

### C. What already exists and was NOT rebuilt

* Task/session/workflow orchestration — Muse **observes** it, and adds no competing runner.
* `tool_execution_logs` — already the AI execution audit trail; reused as agent telemetry.
* `connected_projects` — the existing cross-project registry. Deliberately **not** written to (see collision risks).
* `audit_logs` — untouched; Muse's API keeps its own `muse_access_audit` so the existing trail is not polluted.
* Tax, credit, Drive, Telegram and provider-proxy flows — entirely untouched.

### D. Where Muse lives in the UI

`/muse`, guarded by `RequireSession` inside `MuseShell`, with six tabs:

| Route | Surface |
|---|---|
| `/muse` | Executive brief |
| `/muse/portfolio` | Portfolio map |
| `/muse/loops` | Open loops + decision register |
| `/muse/improvements` | 1% improvement ledger |
| `/muse/sources` | Source authority + conflict register |
| `/muse/systems` | System / agent health |

Reachable from the Hub cover menu as the "Muse" tile (status `beta`).

### E. Schema additions

All objects are prefixed `muse_`. Nothing existing is altered or dropped.
Migration: `supabase/migrations/20260925120000_muse_executive_layer.sql`.

**Registry tables (executive interpretation — 11):**

| Table | Holds |
|---|---|
| `muse_domains` | Portfolio spine: status, owner, systems, source of truth, bottleneck, initiative, next review |
| `muse_source_authority` | Where truth lives per domain/subject, freshness target, confidence, known conflict |
| `muse_open_loops` | Loops with owner, state, dependency, priority, evidence, next action, review date |
| `muse_decisions` | Decision register with context, evidence, options, deadline |
| `muse_improvements` | 1% ledger: baseline, problem, intervention, metric, expected/actual, keep/revise/reverse |
| `muse_systems` | Agent/system registry: role, expected cadence, probe key, blocker, downstream impact |
| `muse_source_conflicts` | Both sides of a disagreement plus a *candidate* authority |
| `muse_verifications` | CLAIMED → ARTIFACT_VERIFIED → SYSTEM_VERIFIED → LIVE_VERIFIED |
| `muse_kpi_registry` | Which metrics matter per domain and whether Control Hub can compute them |
| `muse_api_tokens` | SHA-256 hashes of read tokens (never plaintext) |
| `muse_access_audit` | Every Muse API request; also backs the rate limiter |

**Derived views (read surfaces — 11):**

| View | Derives |
|---|---|
| `muse_system_probe` | Live telemetry from 12 operational tables (last success, last failure, pending, failing) |
| `muse_system_health` | Registry × probe → HEALTHY / FAILING / STALE / NEVER_RAN / NOT_OBSERVED |
| `muse_open_loops_live` | Loops with derived resolution and staleness |
| `muse_decisions_required` | Outstanding decisions with overdue / days-remaining |
| `muse_kpi_derived` | The 11 KPI values Control Hub can actually compute |
| `muse_kpi_summary` | Registry ⟕ derived values, with honest status where unmeasured |
| `muse_source_authority_state` | Register with computed freshness |
| `muse_source_conflicts_open` | Open conflicts |
| `muse_improvement_ledger` | 1% ledger with review-due and measurement state |
| `muse_portfolio_map` | Per-domain rollup incl. primary KPI and live counts |
| `muse_executive_brief` | Ranked brief across eight sections |

### F. Routes / functions added

* UI: the six `/muse/*` routes above.
* Edge function: `supabase/functions/muse-executive` (GET-only read API for Muse-as-agent).
* No existing endpoint, table, env var, workflow or integration was renamed or replaced.

### G. Sources currently reachable

| Source | Status | Via |
|---|---|---|
| Control Hub runtime state (34 tables) | `KNOWN` | `muse_system_probe` across 12 tables |
| Tax & credit client records | `KNOWN` | `clients`, `tax_returns`, `documents`, `dispute_letters` |
| Music activity (pitching/research) | `KNOWN` (activity only, not outcomes) | `pitch_drafts`, `playlist_research` |
| Ad spend | `NEEDS_VERIFICATION` (domain ownership unconfirmed) | `marketing_spend` |
| AI agent execution | `KNOWN` | `tool_execution_logs`, `tasks`, `workflow_runs` |
| Telegram / Remote Mac bridge | `KNOWN` | `telegram_*`, `remote_*` |
| GitHub code/schema | `SOURCE_EXISTS_ACCESS_NEEDED` | registered, no read token wired to Muse |

### H. Missing access

| Source | Why it matters | What is needed |
|---|---|---|
| Boltz Insight Engine (`smrbsnnisvmubbwfhafy`) | Largest unobserved domain: leads, messages, escalations, agent runs, RingCentral + Meta health | Read credential + read views in that project (see the open decision) |
| FanFuel / Artist Growth Hub | Music outcome truth | Read access |
| Lovable deploy state | Nothing can be proven `LIVE_VERIFIED` automatically | A machine-readable deploy or version probe |
| Modest Streetwear | No system of record identified | Fendi to name the system |
| The Workhouse, nonprofit/community | Scope and metric undefined | Fendi to define |
| Personal calendar / mail | Commitments cannot be surfaced | A decision on what Muse may observe |
| AI provider spend (Fal etc.) | Cost is invisible; only call counts are known | Provider read access |

### I. Collision risks (and how each is avoided)

| Risk | Mitigation |
|---|---|
| Lovable regenerating `src/integrations/supabase/types.ts` and dropping Muse types | Muse types are hand-written in `src/lib/muse/types.ts`; reads use an untyped client handle |
| Writing to `connected_projects` would change `telegram-webhook`'s `list_connected_projects` / `get_project_stats` | Muse does not touch that table; cross-project config lives in `muse_source_authority` |
| Changing schema-wide default privileges would affect every future Lovable table | Deliberately not changed; each Muse object revokes `anon` explicitly |
| A new `/muse` route shadowing an existing one | `/muse` was unused; no existing route, table or env var was renamed |
| Polluting the existing `audit_logs` | Muse API access is logged separately in `muse_access_audit` |
| Muse duplicating domain truth | No operational fact is stored; every value comes from a view over the owning table |
| Trigger/policy name clashes | All triggers and policies are created on `muse_*` tables only, with `DROP … IF EXISTS` first |

### J. Minimum implementation plan (what was built)

1. One additive migration: 11 registry tables, 11 views, RLS, privileges, `muse_reader` role, evidence-based seeds.
2. One GET-only edge function for agent access.
3. Six read-only UI surfaces at `/muse`, reusing the existing shell/auth/nav.
4. Verification: a local PostgreSQL assertion suite plus a live post-deploy script.
5. This document.

---

## 2. Muse logic

Every loop, decision and system carries a **classification**, so ordinary
execution is never routed back to Fendi:

`FENDI_DECISION` · `MUSE_ANALYSIS` · `DELEGATE_TO_AGENT` · `AUTOMATED_SYSTEM` · `HUMAN_OWNER` · `WAITING`

**Data status** vocabulary — used on every row and rolled up per response:

`KNOWN` · `AVAILABLE_NOT_CONNECTED` · `SOURCE_EXISTS_ACCESS_NEEDED` · `NOT_MEASURED` · `UNKNOWN` · `NEEDS_VERIFICATION`

**Verification states** — an agent saying "done" is never completion:

`CLAIMED` → `ARTIFACT_VERIFIED` → `SYSTEM_VERIFIED` → `LIVE_VERIFIED`

Rules enforced in SQL, not convention:

* A system with no telemetry reads `NEVER_RAN` / `NOT_MEASURED`, never "healthy".
* A system Muse cannot reach reads `NOT_OBSERVED` and keeps its honest access status.
* A KPI with no computable source has a **NULL value**, never `0`.
* A loop tied to a system derives its resolution from that system, so an
  un-updated row cannot stay open by neglect (`derive_resolution_from`).
* Evidence older than 30 days flags `evidence_stale`.
* An improvement cannot carry a verdict before a measured result, and a
  `CLAIMED` measurement reads `NEEDS_VERIFICATION` until system- or live-verified.
* A queue waiting on a human is counted as `WAITING`, not as a failure.
* An empty brief section is reported as "wired and empty", not as good news.

### Source conflicts

Disagreements are recorded with **both** values and references plus a
`candidate_authority`; Muse never silently picks. One real conflict ships as
seed data: `public.pending_route_clarifications` is created by a migration in
GitHub and referenced by `telegram-webhook`, but is absent from the live
generated schema — so either the migration was never applied or the types are
stale. Candidate authority: the live schema.

---

## 3. Endpoint contract

`GET {SUPABASE_URL}/functions/v1/muse-executive/executive/<resource>`

| Resource | Returns |
|---|---|
| `/executive/brief` | Ranked brief (8 sections) |
| `/executive/portfolio` | Portfolio map |
| `/executive/open-loops` | Open loops |
| `/executive/decisions` | Decisions required |
| `/executive/kpis` | KPIs with honest status |
| `/executive/systems` | Agent/system health |
| `/executive/sources` | Source authority |
| `/executive/conflicts` | Open conflicts |
| `/executive/improvements` | 1% ledger |
| `/executive/verifications` | Verification ledger |

`GET /` (no resource) returns the contract index. Filters are per-resource and
equality-only (`?domain=`, `?state=`, `?section=`, …), plus `?limit=`.

Every response is a structured envelope:

```json
{
  "resource": "systems",
  "generated_at": "2026-09-25T22:40:00.000Z",
  "data_timestamp": "2026-09-25T22:30:00.000Z",
  "authoritative_source": "Live telemetry from the tables that own each fact",
  "freshness_minutes": 10,
  "confidence": "LOW",
  "status": "SOURCE_EXISTS_ACCESS_NEEDED",
  "human_verification_required": true,
  "evidence": ["view:public.muse_system_health", "project:wkzwcfmvnwolgrdpnygc"],
  "row_count": 21,
  "data": [
    {
      "system_key": "ingestion-jobs",
      "name": "Document Ingestion Workers",
      "role": "OCR and field extraction for queued documents",
      "status": "FAILING",
      "data_status": "KNOWN",
      "expected_cadence": "event driven (queue)",
      "last_success_at": "2026-09-25T19:30:00.000Z",
      "last_failure_at": "2026-09-25T22:00:00.000Z",
      "last_failure_detail": "Gemini file expired",
      "pending_count": 1,
      "failing_count": 1,
      "downstream_impact": "Observations and tradelines go stale; credit analysis works from old documents",
      "classification": "AUTOMATED_SYSTEM"
    },
    {
      "system_key": "boltz-insight-engine",
      "name": "Boltz Insight Engine",
      "status": "NOT_OBSERVED",
      "data_status": "SOURCE_EXISTS_ACCESS_NEEDED",
      "blocker": "No read credential for Supabase smrbsnnisvmubbwfhafy",
      "last_success_at": null
    }
  ]
}
```

The envelope status is the **weakest** row's status: a resource is only `KNOWN`
when nothing inside it is unverified or unmeasured.

---

## 4. Authentication and security model

| Consumer | Path | Credential |
|---|---|---|
| Fendi in the Hub UI | Supabase session → `muse_*` views | The existing login. No new credential. |
| Muse as an agent | `muse-executive` edge function | Bearer token, SHA-256 hashed in `muse_api_tokens` |
| Future direct SQL | PostgREST JWT with `role: muse_reader` | DB role with SELECT on the views and nothing else |

Guarantees:

* **GET only.** The function rejects POST/PUT/PATCH/DELETE with 405 before touching data.
* **No arbitrary SQL and no caller-supplied table names** — `RESOURCES` in `contract.ts` is a closed allowlist of `muse_*` views. Unknown resource → 404.
* **Filter values are equality-only** and character-restricted, so nothing resembling a PostgREST operator can be injected.
* **No unrestricted service-role exposure.** The service-role key stays server-side inside the function and is **explicitly rejected** if presented as a Muse token.
* **`anon` is revoked on every Muse object**, overriding Supabase's default grants. Schema-wide defaults are left alone.
* **`muse_reader`** has `SELECT` on the curated views only — no base tables, no registry tables, no token material, no write privilege.
* **Token material is service-role only**: even the signed-in operator cannot read `muse_api_tokens`, and cannot write `muse_access_audit`.
* **Secrets never appear in payloads**: a redaction pass strips key/token/secret/JWT-shaped fields, and the live verifier scans responses for them.
* **Rate limited**: 60 requests/60s per token (`MUSE_RATE_LIMIT`), fixed window over the audit trail.
* **Audited**: every request — allowed, rejected, rate-limited — lands in `muse_access_audit` with a hashed IP.

### Minting a Muse token

```sql
-- In the Lovable SQL editor. Generate the token OUTSIDE the database, store only its hash.
insert into public.muse_api_tokens (label, token_sha256, scopes, expires_at)
values ('muse-agent', encode(digest('<the-token>', 'sha256'), 'hex'), array['read'], now() + interval '90 days');
```

Or set `MUSE_API_TOKEN` in Lovable Cloud secrets as a bootstrap credential.
Never put a token in chat, in the repo, or in a payload.

---

## 5. Deploying (chain of command)

Per `CLAUDE.md`, there is no standalone Supabase. Two steps are Fendi's:

1. **Schema** — paste `supabase/migrations/20260925120000_muse_executive_layer.sql`
   into the **Lovable SQL editor** for this project. It is idempotent and safe to
   re-run **until v2 is applied**; after that, re-run only
   `20260927120000_muse_mission_board.sql` (see [MUSE_MISSION_BOARD.md](./MUSE_MISSION_BOARD.md)).
2. **Edge function** — **Lovable → Edge Functions → redeploy `muse-executive`**.
   (Publish alone does not redeploy functions.)
3. **Frontend** — **Lovable → Publish** to expose `/muse`.
4. **Verify** — `MUSE_API_TOKEN=<token> node scripts/muse/verify-muse-live.mjs`

Until steps 1–3 happen, Muse is `CLAIMED`, not live — and the UI says so instead
of rendering an empty dashboard.

---

## 6. Verification

### Schema + security suite (real PostgreSQL)

```bash
./scripts/muse/verify-muse-sql.sh
```

Builds a throwaway database with a faithful subset of the live Control Hub
schema, applies the migration **twice** (idempotency), loads mixed sample
activity, and asserts every behaviour above — including that `muse_reader` and
`anon` are denied writes and raw-table reads. Status: **all checks passing**
(PostgreSQL 16).

### Live suite (after deploy)

```bash
MUSE_API_TOKEN=<token> node scripts/muse/verify-muse-live.mjs
```

Checks schema presence, endpoint auth, that a Supabase key is refused as a Muse
token, that POST/PUT/PATCH/DELETE all return 405, that unknown resources and
injected filters are refused, that every envelope is well formed, that no
credential-shaped value appears in any payload, and that unknown data is
reported honestly.

### Unit tests

* `src/lib/muse/museFormat.test.ts` (Vitest, 14 tests) — display honesty rules.
* `supabase/functions/muse-executive/contract.test.ts` (Deno) — allowlist, redaction, freshness, status roll-up. Wired into `npm run test:deno` and CI.

---

## 7. Mission board (v2)

Muse v2 turns this layer into a cross-agent operating board — missions, daily improvement,
agent queue, verification queue, impact ledger — with a database-enforced state machine.
Design, schema/API delta and safeguards: [`MUSE_MISSION_BOARD.md`](./MUSE_MISSION_BOARD.md).
Deploy: [`HANDOFF_MUSE_MISSION_BOARD_DEPLOY.md`](./HANDOFF_MUSE_MISSION_BOARD_DEPLOY.md).

## 8. Recommended Phase 2

Only after Phase 1 is live-verified:

1. **Boltz Insight Engine** — highest value. Its schema is already known
   (`leads`, `escalations`, `agent_runs`, `message_jobs`, `meta_lead_submissions`,
   `ringcentral_subscriptions`, `integration_health_snapshots`). Apply a
   `muse_reader`-style read layer in that project, then add a federated adapter.
   `ringcentral_subscriptions.expires_at` in particular is a real silent-failure risk.
2. **GitHub read** — a fine-grained read-only token to show branch, latest commit,
   open PRs and CI status, feeding `muse_verifications` (`CLAIMED` → `ARTIFACT_VERIFIED`).
3. **Live deploy probes** — a version endpoint per surface so `LIVE_VERIFIED` can
   be established by machine rather than asserted.
4. **Worker cadences** — record real schedules in `muse_systems.cadence_minutes`
   so `STALE` detection works for every worker, not just the Mac bridge.
5. **FanFuel / AGH** — music outcome truth, and resolve the duplicate-truth question.
6. **Muse tools in the existing agent framework** — expose these views as
   read-only tools in `telegram-webhook`'s registry so Muse is queryable from chat.
7. **Controlled write path** — if Muse should ever record a decision, route it
   through the existing task/workflow execution mechanism, never by widening the
   read API.
