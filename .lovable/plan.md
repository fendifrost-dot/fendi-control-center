

## Plan: Sync and Deploy Edge Functions from Commit 8d201e9

### Steps

1. **Verify GitHub sync** — Check that commit 8d201e9 is reflected in the workspace by inspecting `supabase/functions/ingest-tax-documents/index.ts` for `normalizeToExtractedData` and `supabase/functions/_shared/geminiParser.ts` for the `...parsed` spread.

2. **Deploy all edge functions** — Deploy every edge function listed in `supabase/config.toml` plus any others present in `supabase/functions/`:
   - `analyze-credit-strategy`
   - `backfill-embeddings`
   - `credit-knowledge-retrieval`
   - `drive-sync`
   - `export-txf`
   - `fill-tax-forms`
   - `generate-dispute-letters`
   - `generate-pitch-email`
   - `generate-tax-documents`
   - `import-prior-return`
   - `ingest-drive-clients`
   - `ingest-tax-documents`
   - `instagram-messaging`
   - `meta-token-validate`
   - `notify-telegram`
   - `parse-financial-statement`
   - `playlist-research`
   - `process-document`
   - `regenerate-tax-pdfs`
   - `setup-telegram-webhook`
   - `tax-returns`
   - `telegram-outbox-flush`
   - `telegram-webhook`
   - `upload-irs-forms`

3. **Verify deployment** — Confirm `normalizeToExtractedData` exists in the deployed `ingest-tax-documents` source, report deployed function names and timestamp.

### Constraints
- No source files modified
- No `verify_jwt` changes
- Deploy-only operation

