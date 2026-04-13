

## Plan: Async Statement-Chunk Processing Pipeline

### What This Does
Large bank statement PDFs (>50MB) are currently queued in an in-memory blob but never picked up. This creates a durable database table, two new edge functions (dispatcher + worker), updates the ingest function to write durable job records, and schedules automatic dispatch every 2 minutes.

---

### Step 1: Database Migration — `statement_chunk_jobs` table

Create table with all specified columns including `source_type` (default `'drive'`), `claimed_at`, `started_at`, `completed_at`. Indexes on `(status, created_at)`, `(client_id, tax_year)`, and a partial unique index `(client_id, tax_year, file_id) WHERE status IN (...)`. RLS: service_role full access, authenticated select-only. Trigger using existing `update_updated_at_column()`.

### Step 2: New Edge Function — `statement-chunk-dispatch/index.ts`

- Select oldest jobs with `status='requires_async_processing'` and `attempts < 3`
- Atomically claim: `status='processing_chunked'`, `attempts++`, `claimed_at=now()`
- If `attempts >= 3`, mark `dead_letter` instead of claiming
- Invoke `statement-chunk-worker` for each via `fetch()` (fire-and-forget)
- If invoke fails: set `status='chunk_processing_failed'`, `last_error='dispatch_invoke_failed:...'`
- Return `{ picked, started, failed_to_start, job_ids }`

### Step 3: New Edge Function — `statement-chunk-worker/index.ts`

- Load job from `statement_chunk_jobs`; validate `status='processing_chunked'`; no-op if terminal
- Set `started_at=now()`
- Download source: `source_type='drive'` → `downloadFile()` from `googleDriveRead.ts`; `source_type='storage'` → download from Supabase Storage using `storage_object_path` stored in the job record (the `file_id` column stores the `storage_object_path` for storage-mode jobs as a deterministic `source_ref`)
- `splitPdfIntoPages()` → `chunkPages(pages, 5)`
- Per chunk: OCR scanned pages → `extractStatementChunk()` → retry once on failure
- `mergeChunkResults()` → dedupe
- Hard rules: zero income; never `completed` with 0 transactions
- Update job with lineage fields + final status (`completed` / `partial_success` / `chunk_processing_failed` / `dead_letter`)

### Step 4: Update `ingest-tax-documents/index.ts`

Modify `createStatementChunkJob()` to also INSERT into the `statement_chunk_jobs` table. For storage-mode uploads, `file_id` will store the `storage_object_path` as the deterministic source reference (so the worker can always locate the object regardless of source type), and `source_type` is set to `'storage'`. For drive-mode, `file_id` stores the Drive file ID and `source_type='drive'`. No other logic changes needed — async routing, response format, and aggregate accounting are already implemented.

### Step 5: Update `supabase/config.toml`

Add:
```
[functions.statement-chunk-dispatch]
verify_jwt = false

[functions.statement-chunk-worker]
verify_jwt = false
```

### Step 6: Scheduling

Use the insert tool (not migration) to create a `pg_cron` schedule calling `statement-chunk-dispatch` every 2 minutes via `net.http_post`. Auth header uses the anon key from environment.

### Step 7: Deploy + Validate

Deploy all 26 edge functions. Run live validation for Sam Higgins 2022:
1. `mode=list` — verify file listing
2. `mode=process_single` for CHASE 2022/2022.pdf — assert:
   - `status == 'requires_async_processing'` (NOT `processed`)
   - `ingest_status == 'requires_async_processing'` (explicit check)
   - `chunk_job_id` present
   - `meta.version == 'async-chunk-v1'`
3. `mode=aggregate` — assert `files_with_errors`, `statements_failed`, zero statement income
4. Verify `statement_chunk_jobs` row exists in DB with correct status

### Files Changed

| File | Action |
|------|--------|
| Migration SQL | **Create** (table + indexes + RLS + trigger) |
| `supabase/functions/statement-chunk-worker/index.ts` | **Create** |
| `supabase/functions/statement-chunk-dispatch/index.ts` | **Create** |
| `supabase/functions/ingest-tax-documents/index.ts` | **Edit** (~15 lines: add DB insert in `createStatementChunkJob`) |
| `supabase/config.toml` | **Edit** (add 2 function blocks) |
| pg_cron schedule | **Insert** via data tool |

