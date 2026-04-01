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