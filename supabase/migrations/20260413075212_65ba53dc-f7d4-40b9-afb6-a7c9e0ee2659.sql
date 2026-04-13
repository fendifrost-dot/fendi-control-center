
CREATE TABLE public.statement_chunk_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  tax_year integer NOT NULL,
  file_id text NOT NULL,
  file_name text NOT NULL,
  relative_path text,
  source_type text NOT NULL DEFAULT 'drive',
  file_size_bytes bigint,
  chunk_size_pages integer NOT NULL DEFAULT 5,
  chunk_count integer,
  pages_total integer,
  pages_processed integer DEFAULT 0,
  pages_failed integer DEFAULT 0,
  transactions_extracted integer DEFAULT 0,
  status text NOT NULL DEFAULT 'requires_async_processing',
  reason_codes jsonb DEFAULT '[]'::jsonb,
  warning_flags jsonb DEFAULT '[]'::jsonb,
  extracted_payload jsonb,
  attempts integer DEFAULT 0,
  last_error text,
  claimed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_scj_status_created ON public.statement_chunk_jobs (status, created_at);
CREATE INDEX idx_scj_client_year ON public.statement_chunk_jobs (client_id, tax_year);

CREATE UNIQUE INDEX idx_scj_active_idempotent
  ON public.statement_chunk_jobs (client_id, tax_year, file_id)
  WHERE status IN ('requires_async_processing', 'processing_chunked');

ALTER TABLE public.statement_chunk_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access"
  ON public.statement_chunk_jobs
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read access"
  ON public.statement_chunk_jobs
  FOR SELECT TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE TRIGGER set_statement_chunk_jobs_updated_at
  BEFORE UPDATE ON public.statement_chunk_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
