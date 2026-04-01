-- AI integration blueprint rollout:
-- - New storage tables for Claude/OpenAI workflows
-- - Workflow registry entries for new credit + playlist pipelines

CREATE TABLE IF NOT EXISTS public.credit_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  analysis_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'generated',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.dispute_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  analysis_id uuid NULL REFERENCES public.credit_analyses(id) ON DELETE SET NULL,
  bureau text,
  letter_content text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.playlist_research (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_name text NOT NULL,
  genre text,
  results_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pitch_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_id uuid NULL REFERENCES public.playlist_research(id) ON DELETE SET NULL,
  playlist_id text NOT NULL,
  email_subject text NOT NULL,
  email_body text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.workflows (key, name, description, trigger_phrases, tools)
VALUES
  (
    'analyze_credit_strategy',
    'Analyze Credit Strategy',
    'Analyze a client credit profile and produce prioritized dispute strategy.',
    '["analyze credit strategy", "analyze client credit", "credit strategy"]'::jsonb,
    '["analyze_credit_strategy"]'::jsonb
  ),
  (
    'credit_analysis_and_disputes',
    'Credit Analysis And Disputes',
    'Run end-to-end credit strategy and dispute letter workflow.',
    '["credit analysis and disputes", "full credit pipeline", "analyze and dispute"]'::jsonb,
    '["analyze_credit_strategy", "generate_dispute_letter", "send_dispute_letter"]'::jsonb
  ),
  (
    'playlist_pitch_workflow',
    'Playlist Pitch Workflow',
    'Run playlist research, pitch draft generation, and send approval flow.',
    '["playlist pitch workflow", "research playlists and pitch", "generate playlist pitch"]'::jsonb,
    '["research_playlists", "generate_pitch", "send_pitch"]'::jsonb
  )
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  trigger_phrases = EXCLUDED.trigger_phrases,
  tools = EXCLUDED.tools,
  updated_at = now();
