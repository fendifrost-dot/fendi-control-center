
-- =============================================================
-- Credit Case Control Center — Phase 1: Database Foundation
-- Initial schema — future changes additive only unless confirmed
-- =============================================================

-- =====================
-- TABLE 1: clients
-- =====================
CREATE TABLE public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  drive_folder_id text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- =====================
-- TABLE 2: documents
-- =====================
CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.clients(id) NOT NULL,
  drive_file_id text UNIQUE NOT NULL,
  drive_parent_folder_id text,
  drive_modified_time timestamptz NOT NULL,
  sha256 text NOT NULL,
  mime_type text NOT NULL,
  original_mime_type text NOT NULL,
  processed_mime_type text DEFAULT 'application/pdf' NOT NULL,
  file_name text NOT NULL,
  doc_type text,
  bureau text,
  report_date date,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','processed','error')),
  conversion_status text,
  is_deleted boolean DEFAULT false NOT NULL,
  replaced_by_document_id uuid REFERENCES public.documents(id),
  source_version integer DEFAULT 1 NOT NULL,
  gemini_file_uri text,
  gemini_file_expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- =====================
-- TABLE 3: extracted_pages
-- =====================
CREATE TABLE public.extracted_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES public.documents(id) NOT NULL,
  page_number integer NOT NULL,
  text text,
  ocr_used boolean DEFAULT false NOT NULL,
  ocr_confidence numeric,
  page_sha256 text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT unique_doc_page UNIQUE (document_id, page_number)
);

-- =====================
-- TABLE 4: observations
-- =====================
CREATE TABLE public.observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.clients(id) NOT NULL,
  document_id uuid REFERENCES public.documents(id) NOT NULL,
  page_number integer,
  object_type text NOT NULL,
  object_key text NOT NULL,
  field_name text NOT NULL,
  field_value_text text,
  field_value_json jsonb,
  confidence numeric NOT NULL,
  evidence_snippet text,
  evidence_page_range text,
  bbox_json jsonb,
  model_id text NOT NULL DEFAULT 'gemini-2.5-pro',
  created_at timestamptz DEFAULT now()
);

-- =====================
-- TABLE 5: conflicts
-- =====================
CREATE TABLE public.conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.clients(id) NOT NULL,
  object_type text NOT NULL,
  object_key text NOT NULL,
  reason text NOT NULL,
  observation_ids jsonb NOT NULL,
  status text DEFAULT 'open' NOT NULL,
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz
);

-- =====================
-- TABLE 6: ingestion_jobs
-- =====================
CREATE TABLE public.ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.clients(id),
  drive_file_id text,
  document_id uuid REFERENCES public.documents(id),
  job_type text NOT NULL,
  status text NOT NULL,
  attempt_count integer DEFAULT 0 NOT NULL,
  last_error text,
  started_at timestamptz,
  heartbeat_at timestamptz,
  completed_at timestamptz,
  worker_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- =====================
-- TABLE 7: drive_sync_runs
-- =====================
CREATE TABLE public.drive_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL,
  drive_start_page_token text,
  drive_new_page_token text,
  last_error text
);

-- =====================
-- TABLE 8: drive_sync_events
-- =====================
CREATE TABLE public.drive_sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES public.drive_sync_runs(id) NOT NULL,
  client_id uuid REFERENCES public.clients(id),
  drive_file_id text NOT NULL,
  event_type text NOT NULL,
  drive_modified_time timestamptz NOT NULL,
  previous_modified_time timestamptz,
  is_deleted boolean DEFAULT false NOT NULL,
  status text NOT NULL,
  attempt_count integer DEFAULT 0 NOT NULL,
  last_error text,
  created_at timestamptz DEFAULT now()
);

-- =====================
-- TABLE 9: audit_logs
-- =====================
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) NOT NULL,
  client_id uuid,
  action text NOT NULL,
  details jsonb,
  created_at timestamptz DEFAULT now()
);

-- =============================================================
-- INDEXES
-- =============================================================

-- Unique index: prevents duplicate observations per extraction
CREATE UNIQUE INDEX obs_unique ON public.observations (client_id, object_type, object_key, field_name, document_id, page_number);

-- Composite index: efficient client document lookups
CREATE INDEX idx_documents_client_modified ON public.documents (client_id, drive_modified_time);

-- Composite index: stuck job detection
CREATE INDEX idx_ingestion_jobs_status_heartbeat ON public.ingestion_jobs (status, heartbeat_at);

-- =============================================================
-- RLS: Enable on ALL tables + permissive single-user policy
-- =============================================================

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extracted_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_sync_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated full access" ON public.clients FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated full access" ON public.documents FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated full access" ON public.extracted_pages FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated full access" ON public.observations FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated full access" ON public.conflicts FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated full access" ON public.ingestion_jobs FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated full access" ON public.drive_sync_runs FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated full access" ON public.drive_sync_events FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated full access" ON public.audit_logs FOR ALL USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);

-- =============================================================
-- VIEWS: Deterministic current-state resolution
-- =============================================================

-- Helper: deterministic row selection per (client_id, object_type, object_key, field_name)
-- Priority: 1) highest confidence, 2) newest created_at, 3) preferred bureau/doc_type

CREATE OR REPLACE VIEW public.current_tradelines AS
SELECT DISTINCT ON (o.client_id, o.object_key, o.field_name)
  o.id,
  o.client_id,
  o.document_id,
  o.page_number,
  o.object_type,
  o.object_key,
  o.field_name,
  o.field_value_text,
  o.field_value_json,
  o.confidence,
  o.evidence_snippet,
  o.evidence_page_range,
  o.model_id,
  o.created_at,
  d.bureau,
  d.doc_type
FROM public.observations o
JOIN public.documents d ON d.id = o.document_id
WHERE o.object_type = 'tradeline'
  AND d.is_deleted = false
ORDER BY
  o.client_id,
  o.object_key,
  o.field_name,
  o.confidence DESC,
  o.created_at DESC,
  CASE
    WHEN d.bureau IN ('equifax','experian','transunion') THEN 0
    ELSE 1
  END,
  CASE
    WHEN d.doc_type = 'full_report' THEN 0
    WHEN d.doc_type = 'dispute_response' THEN 1
    ELSE 2
  END;

CREATE OR REPLACE VIEW public.current_inquiries AS
SELECT DISTINCT ON (o.client_id, o.object_key, o.field_name)
  o.id,
  o.client_id,
  o.document_id,
  o.page_number,
  o.object_type,
  o.object_key,
  o.field_name,
  o.field_value_text,
  o.field_value_json,
  o.confidence,
  o.evidence_snippet,
  o.evidence_page_range,
  o.model_id,
  o.created_at,
  d.bureau,
  d.doc_type
FROM public.observations o
JOIN public.documents d ON d.id = o.document_id
WHERE o.object_type = 'inquiry'
  AND d.is_deleted = false
ORDER BY
  o.client_id,
  o.object_key,
  o.field_name,
  o.confidence DESC,
  o.created_at DESC,
  CASE
    WHEN d.bureau IN ('equifax','experian','transunion') THEN 0
    ELSE 1
  END,
  CASE
    WHEN d.doc_type = 'full_report' THEN 0
    WHEN d.doc_type = 'dispute_response' THEN 1
    ELSE 2
  END;

CREATE OR REPLACE VIEW public.current_personal_info AS
SELECT DISTINCT ON (o.client_id, o.object_key, o.field_name)
  o.id,
  o.client_id,
  o.document_id,
  o.page_number,
  o.object_type,
  o.object_key,
  o.field_name,
  o.field_value_text,
  o.field_value_json,
  o.confidence,
  o.evidence_snippet,
  o.evidence_page_range,
  o.model_id,
  o.created_at,
  d.bureau,
  d.doc_type
FROM public.observations o
JOIN public.documents d ON d.id = o.document_id
WHERE o.object_type = 'personal_info'
  AND d.is_deleted = false
ORDER BY
  o.client_id,
  o.object_key,
  o.field_name,
  o.confidence DESC,
  o.created_at DESC,
  CASE
    WHEN d.bureau IN ('equifax','experian','transunion') THEN 0
    ELSE 1
  END,
  CASE
    WHEN d.doc_type = 'full_report' THEN 0
    WHEN d.doc_type = 'dispute_response' THEN 1
    ELSE 2
  END;
