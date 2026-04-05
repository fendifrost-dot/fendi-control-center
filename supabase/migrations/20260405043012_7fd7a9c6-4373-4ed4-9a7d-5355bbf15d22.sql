-- Tax Forensics: client-centric workflow — client contact fields, upload docs, year workspace data

-- -----------------------------------------------------------------------------
-- clients: optional Drive folder for dashboard-created clients; contact info
-- -----------------------------------------------------------------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS business_type text;

ALTER TABLE public.clients ALTER COLUMN drive_folder_id DROP NOT NULL;

ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_drive_folder_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS clients_drive_folder_id_unique
  ON public.clients (drive_folder_id)
  WHERE drive_folder_id IS NOT NULL AND length(trim(drive_folder_id)) > 0;

-- -----------------------------------------------------------------------------
-- documents: tax-year uploads via Supabase Storage (source = upload)
-- -----------------------------------------------------------------------------
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS tax_year integer,
  ADD COLUMN IF NOT EXISTS storage_object_path text,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'drive';

ALTER TABLE public.documents
  ALTER COLUMN drive_file_id DROP NOT NULL;

ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_drive_file_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS documents_drive_file_id_unique
  ON public.documents (drive_file_id)
  WHERE drive_file_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_client_tax_year
  ON public.documents (client_id, tax_year)
  WHERE is_deleted = false;

COMMENT ON COLUMN public.documents.storage_object_path IS 'Path within tax-source-documents bucket for dashboard uploads';
COMMENT ON COLUMN public.documents.source IS 'drive | upload';

-- -----------------------------------------------------------------------------
-- tax_returns: analyzed pipeline output + per-year settings (dashboard)
-- -----------------------------------------------------------------------------
ALTER TABLE public.tax_returns
  ADD COLUMN IF NOT EXISTS analyzed_data jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS workspace_settings jsonb DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.tax_returns.analyzed_data IS 'Income/expense items and P&L from ingestion; editable in UI';
COMMENT ON COLUMN public.tax_returns.workspace_settings IS 'Filing status, dependents, state — year workspace settings';

-- -----------------------------------------------------------------------------
-- Storage: tax document uploads
-- -----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'tax-source-documents',
  'tax-source-documents',
  false,
  52428800,
  ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif'
  ]::text[]
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "tax-source-documents authenticated insert" ON storage.objects;
DROP POLICY IF EXISTS "tax-source-documents authenticated select" ON storage.objects;
DROP POLICY IF EXISTS "tax-source-documents authenticated update" ON storage.objects;
DROP POLICY IF EXISTS "tax-source-documents authenticated delete" ON storage.objects;

CREATE POLICY "tax-source-documents authenticated insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'tax-source-documents');

CREATE POLICY "tax-source-documents authenticated select"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'tax-source-documents');

CREATE POLICY "tax-source-documents authenticated update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'tax-source-documents')
  WITH CHECK (bucket_id = 'tax-source-documents');

CREATE POLICY "tax-source-documents authenticated delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'tax-source-documents');