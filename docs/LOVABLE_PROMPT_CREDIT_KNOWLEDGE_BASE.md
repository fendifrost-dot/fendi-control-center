# Lovable implementation prompt: Credit knowledge base + retrieval layer

Use this spec when adding the **vector-backed knowledge base** and **retrieval API** in the Supabase project managed through **Lovable**.  
**Scope:** credit systems only. **Additive only** — do not alter existing non-credit tables or workflows.

---

## OBJECTIVE

Introduce a structured knowledge base and vector retrieval system to support credit-related AI tasks. Store past disputes, analysis patterns, and violation logic; retrieve relevant knowledge during AI execution so outputs stay consistent and high quality.

---

## SCOPE (STRICT)

**Applies ONLY to:**

- Credit Guardian / Credit Compass (Fairway project)
- Credit-related Control Center Edge Functions and Telegram workflows that call retrieval

**Must NOT affect:**

- Tax systems (e.g. CC Tax, taxgenerator, tax Drive sync)
- Artist / playlist / FanFuel systems
- Auto or website systems
- Non-credit Telegram lanes

Do **not** add retrieval calls, secrets, or DB dependencies to those code paths.

---

## ALIGNMENT WITH CONTROL CENTER (EXISTING CONTRACT)

The Control Center repo already implements orchestration that calls optional **`CREDIT_RETRIEVAL_URL`** with a **POST JSON body**:

```json
{
  "task": "credit_analysis | response_analysis | dispute_generation",
  "intentSummary": "string",
  "caseStateSummary": "string | null",
  "maxItems": 8
}
```

The Edge Function maps the response into **`disputeExamples`**, **`analysisPatterns`**, and **`violationLogic`** (arrays of strings) for prompt injection.

**Requirement:** The Lovable-built retrieval endpoint must either:

1. **Accept this body directly** and return JSON that maps to those three arrays (e.g. by splitting/folding row `content` by `type`), **or**
2. Expose an internal handler that performs DB + vector search, then **maps** rows → `{ disputeExamples, analysisPatterns, violationLogic }` before responding.

Do **not** introduce a second incompatible public contract without updating the Control Center client in the same release plan.

---

## DATABASE SETUP (NEW TABLE ONLY)

**Do not modify existing tables.** Create one new table:

### `credit_knowledge_base`

| Column       | Type        | Notes |
|-------------|-------------|--------|
| `id`        | `uuid` PK   | `gen_random_uuid()` default |
| `type`      | `text`      | e.g. `dispute`, `analysis`, `violation_pattern`, `parser_rule` |
| `case_type` | `text`      | e.g. `identity_theft`, `mixed_file` (nullable if generic) |
| `trigger`   | `text`      | e.g. `reinserted_account`, `late_payment`, `collection` (nullable) |
| `content`   | `text`      | Dispute text, analysis snippet, or rule (may contain PII — see security) |
| `embedding` | `vector(N)` | **N must match** the chosen embedding model (e.g. **1536** for OpenAI `text-embedding-3-small`). Nullable until backfilled. |
| `metadata`  | `jsonb`     | Optional structured context (e.g. `{ "source": "import", "cg_client_id": "..." }`) |
| `created_at`| `timestamptz` | default `now()` |

**Optional (recommended):**

- `updated_at timestamptz`
- `is_active boolean default true` (soft-disable bad rows)
- `source text` — `manual | import | ai_generated`

**Extensions**

1. `CREATE EXTENSION IF NOT EXISTS vector;` (or equivalent on host)
2. Create table
3. **Indexes:**
   - Partial or btree indexes on `case_type`, `trigger` **if** you filter on them before vector search
   - **Vector index** on `embedding` using **ivfflat** or **hnsw** (cosine or L2—match query code). For **ivfflat**, consider a follow-up migration after enough rows exist, or use sensible `lists`
4. **Never** full-table scan for production retrieval paths

**RLS:** Enable RLS on `credit_knowledge_base`. **No** anonymous or authenticated user policies for broad read. Only **service role** (or dedicated server role used by Edge Functions) may `SELECT`/`INSERT`/`UPDATE`.

---

## EMBEDDINGS

- On **insert** or **update** of `content`, generate embedding with the **same model/dimensions** as the `embedding` column.
- If `content` changes, **re-embed** and update `embedding`.
- Rows with `embedding IS NULL` must be **excluded** from vector search or handled by a backfill job (do not return broken similarity).

---

## RETRIEVAL FUNCTION (REUSABLE)

Implement **`retrieveRelevantKnowledge`** semantics server-side (Edge Function or RPC invoked by Edge Function):

### Input

- **Primary:** `query` text derived from `intentSummary` + optional `caseStateSummary` (or use the Control Center POST body fields above as the query source).
- **Optional filters:** `case_type`, `trigger` (from request body or parsed metadata).

### Process (order)

1. **Structured filter first:** `WHERE` on `case_type` / `trigger` when provided; `is_active = true` if column exists.
2. **Vector similarity** on **filtered** rows with non-null `embedding`.
3. **Similarity threshold** (recommended): drop matches below a configurable minimum similarity / max distance to avoid irrelevant rows as the table grows.
4. **Limit:** return **at most 10** rows total.

### Output (internal)

Per row (do **not** expose raw embeddings):

- `content`
- `type`
- `case_type`
- `trigger`
- `metadata`

### Output (external / Control Center compatible)

Map the top 5–10 rows into:

```json
{
  "disputeExamples": ["..."],
  "analysisPatterns": ["..."],
  "violationLogic": ["..."]
}
```

by routing each row’s `content` into the bucket implied by `type` (and/or `metadata`), or by a simple rule set documented in code.

---

## SAFETY

- **Max 10** results; no raw **embedding** vectors in JSON responses or logs.
- **PII:** treat `content` as sensitive; restrict access; avoid logging full `content` in production.
- **Domain:** retrieval must only query **`credit_knowledge_base`** — no joins to tax or unrelated schemas for this feature.

---

## PERFORMANCE

- Same region as database for the retrieval Edge Function when possible.
- Use vector indexes; avoid `SELECT *` including `embedding` in API responses—select columns explicitly.

---

## BACKWARD COMPATIBILITY

- **Additive only:** new table + new Edge Function (or RPC); **no** changes to existing tables, existing credit processing pipelines, or unrelated apps.
- **Empty table:** retrieval returns empty arrays → Control Center already **fails open** to base prompts only.
- Deploy order: migrate table → optionally backfill embeddings → deploy retrieval URL → set **`CREDIT_RETRIEVAL_URL`** in Control Center secrets when ready.

---

## END STATE

- Prior disputes and analysis patterns can be stored and embedded.
- Retrieval returns relevant, filtered, vector-ranked knowledge **without** breaking existing workflows.
- Credit AI outputs gain consistency when **`CREDIT_RETRIEVAL_URL`** is configured.

---

## REFERENCE (CONTROL CENTER REPO)

Orchestration and prompt assembly live in **`fendi-control-center`**:

- `supabase/functions/_shared/retrieveRelevantKnowledge.ts`
- `supabase/functions/_shared/creditPromptComposer.ts`
- `supabase/functions/analyze-credit-strategy/index.ts`
- `supabase/functions/generate-dispute-letters/index.ts`

Secrets: `CREDIT_RETRIEVAL_URL`, optional `CREDIT_RETRIEVAL_INLINE_JSON` (dev only).

---

*End of Lovable prompt.*
