
-- Add external orchestration columns to statement_chunk_jobs
ALTER TABLE public.statement_chunk_jobs
  ADD COLUMN IF NOT EXISTS external_provider text,
  ADD COLUMN IF NOT EXISTS external_job_id text,
  ADD COLUMN IF NOT EXISTS external_status text,
  ADD COLUMN IF NOT EXISTS external_endpoint text,
  ADD COLUMN IF NOT EXISTS callback_token_hash text,
  ADD COLUMN IF NOT EXISTS callback_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS external_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS external_last_error text,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS processor_version text,
  ADD COLUMN IF NOT EXISTS processing_mode text NOT NULL DEFAULT 'edge',
  ADD COLUMN IF NOT EXISTS finalized_by text;

-- Indexes for external dispatch queries
CREATE INDEX IF NOT EXISTS idx_scj_external_status_retry
  ON public.statement_chunk_jobs (external_status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_scj_mode_status_created
  ON public.statement_chunk_jobs (processing_mode, status, created_at);
