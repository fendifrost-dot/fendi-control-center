-- ---------------------------------------------------------------------------
-- Faithful subset of the LIVE Control Hub schema, for validating the Muse
-- migration against a real PostgreSQL server without touching production.
--
-- Column definitions are copied from supabase/migrations/* and from the live
-- generated schema mirror (src/integrations/supabase/types.ts). Only the
-- tables/columns the Muse views read are reproduced.
--
-- This is a syntax + logic harness, not a replica of production data.
-- ---------------------------------------------------------------------------

-- Supabase roles the migration grants to.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
END $$;

-- Supabase's auth.uid() stand-in.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  business_type text,
  client_pipeline text NOT NULL DEFAULT 'tax',
  drive_folder_id text,
  email text,
  phone text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.drive_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL,
  drive_start_page_token text,
  drive_new_page_token text,
  last_error text
);

CREATE TABLE IF NOT EXISTS public.ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid,
  drive_file_id text,
  document_id uuid,
  job_type text NOT NULL,
  status text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz,
  heartbeat_at timestamptz,
  completed_at timestamptz,
  worker_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.statement_chunk_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  file_id text NOT NULL,
  file_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  prep_status text NOT NULL DEFAULT 'pending',
  prep_error text,
  last_error text,
  tax_year integer NOT NULL DEFAULT 2025,
  chunk_size_pages integer NOT NULL DEFAULT 10,
  processing_mode text NOT NULL DEFAULT 'chunked',
  source_type text NOT NULL DEFAULT 'drive',
  external_attempts integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'queued',
  requested_model text,
  request_text text NOT NULL,
  selected_workflow text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.telegram_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  chat_id text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  attempt_count int NOT NULL DEFAULT 0,
  last_error text,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.telegram_webhook_processed_updates (
  update_id bigint PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.telegram_approval_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  document_id uuid NOT NULL,
  observation_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  telegram_message_id integer,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pending_guardian_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id text NOT NULL,
  source text NOT NULL DEFAULT 'document',
  file_unique_id text NOT NULL,
  client_name text NOT NULL,
  cg_client_id uuid,
  event_type text NOT NULL DEFAULT 'responses_received',
  bureau text NOT NULL,
  bureau_canonical text NOT NULL,
  round smallint,
  drive_file_id text NOT NULL,
  drive_file_name text NOT NULL,
  drive_path text NOT NULL,
  ocr_text text,
  status text NOT NULL DEFAULT 'pending',
  delivered_at timestamptz,
  delivery_error text,
  error_message text,
  retry_count integer NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text,
  client_name text,
  tax_year integer,
  intent text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  current_stage text NOT NULL DEFAULT 'load_state',
  result_payload jsonb,
  error jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.remote_bridge_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_name text NOT NULL,
  last_seen_at timestamptz,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.remote_command_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid,
  source text NOT NULL DEFAULT 'telegram',
  source_ref text,
  command_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  reply_chat_id text,
  result_json jsonb,
  error text,
  claimed_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tool_execution_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL,
  tool_name text NOT NULL,
  args jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'attempted'
    CONSTRAINT tool_execution_logs_status_check CHECK (status IN ('attempted','succeeded','failed')),
  error text,
  elapsed_ms integer,
  model text,
  chat_id text,
  http_status integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.tax_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  client_name text,
  tax_year integer NOT NULL,
  status text DEFAULT 'draft',
  filed_at timestamptz,
  agi numeric,
  total_income numeric,
  total_tax numeric,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.dispute_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  bureau text NOT NULL,
  account_name text,
  dispute_reason text,
  letter_content text,
  status text DEFAULT 'draft',
  model text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.marketing_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid,
  platform text NOT NULL DEFAULT 'meta',
  campaign_id text,
  campaign_name text,
  spend numeric(12,2) NOT NULL DEFAULT 0,
  impressions integer DEFAULT 0,
  clicks integer DEFAULT 0,
  conversions integer DEFAULT 0,
  date date NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pitch_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL DEFAULT 'email',
  curator_email text,
  curator_name text,
  dm_content text,
  instagram_handle text,
  model text,
  pitch_content text,
  playlist_id text,
  status text DEFAULT 'draft',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.playlist_research (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_name text NOT NULL,
  track_name text NOT NULL,
  genre text,
  model text,
  research jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Mirror the existing Hub convention so the Muse views are validated against
-- RLS-enabled base tables, as in production.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clients','tax_returns','dispute_letters','marketing_spend',
                           'pitch_drafts','playlist_research','tasks'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "Authenticated full access" ON public.%I FOR ALL TO public USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated, anon', t);
  END LOOP;
END $$;
