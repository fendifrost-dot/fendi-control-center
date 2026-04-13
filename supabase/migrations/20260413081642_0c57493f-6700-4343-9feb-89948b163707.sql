
-- Add pre-stage columns to statement_chunk_jobs
ALTER TABLE public.statement_chunk_jobs
  ADD COLUMN IF NOT EXISTS source_storage_bucket text,
  ADD COLUMN IF NOT EXISTS source_storage_path text,
  ADD COLUMN IF NOT EXISTS source_drive_file_id text,
  ADD COLUMN IF NOT EXISTS source_bytes bigint,
  ADD COLUMN IF NOT EXISTS prep_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS prep_error text,
  ADD COLUMN IF NOT EXISTS prep_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS prep_completed_at timestamptz;

-- Index for prep dispatch queries
CREATE INDEX IF NOT EXISTS idx_scj_prep_status_created
  ON public.statement_chunk_jobs (prep_status, created_at);

-- Create storage bucket for chunk source staging
INSERT INTO storage.buckets (id, name, public)
VALUES ('tax-chunk-source', 'tax-chunk-source', false)
ON CONFLICT (id) DO NOTHING;

-- RLS: service_role full access on bucket
CREATE POLICY "Service role full access on tax-chunk-source"
  ON storage.objects FOR ALL
  TO service_role
  USING (bucket_id = 'tax-chunk-source')
  WITH CHECK (bucket_id = 'tax-chunk-source');
