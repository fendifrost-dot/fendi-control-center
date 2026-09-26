-- Sample operational activity so the derived Muse views have something to
-- compute from. Deliberately mixed: one healthy worker, one failing worker,
-- one queue waiting on a human, one never-ran worker.

INSERT INTO public.clients (id, name, client_pipeline) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Test Client A', 'tax'),
  ('22222222-2222-2222-2222-222222222222', 'Test Client B', 'credit');

-- drive_sync: healthy (a clean completed run 10 minutes ago)
INSERT INTO public.drive_sync_runs (started_at, completed_at, status, last_error) VALUES
  (now() - interval '20 minutes', now() - interval '10 minutes', 'completed', NULL);

-- ingestion_jobs: FAILING (last event is an error newer than the last success)
INSERT INTO public.ingestion_jobs (job_type, status, last_error, completed_at, updated_at) VALUES
  ('extract', 'succeeded', NULL, now() - interval '3 hours', now() - interval '3 hours'),
  ('extract', 'failed', 'Gemini file expired', NULL, now() - interval '30 minutes');

-- telegram_outbox: healthy plus one historical failure
INSERT INTO public.telegram_outbox (task_id, chat_id, kind, status, sent_at, last_error, last_attempt_at) VALUES
  (gen_random_uuid(), '123', 'reply', 'sent', now() - interval '5 minutes', NULL, now() - interval '5 minutes'),
  (gen_random_uuid(), '123', 'reply', 'failed', NULL, 'HTTP 429', now() - interval '2 days');

INSERT INTO public.telegram_webhook_processed_updates (update_id, received_at) VALUES
  (1001, now() - interval '4 minutes');

-- approval queue: 2 items waiting on a human (not a fault)
INSERT INTO public.telegram_approval_queue (client_id, document_id, observation_count, status) VALUES
  ('11111111-1111-1111-1111-111111111111', gen_random_uuid(), 7, 'pending'),
  ('11111111-1111-1111-1111-111111111111', gen_random_uuid(), 3, 'pending');

-- remote bridge: stale heartbeat (cadence 30 min, last seen 5 hours ago)
INSERT INTO public.remote_bridge_devices (device_name, last_seen_at, status) VALUES
  ('primary-mac', now() - interval '5 hours', 'active');

-- tool executor: healthy with recent failures for the KPI
INSERT INTO public.tool_execution_logs (request_id, tool_name, status, error, started_at, completed_at, model) VALUES
  ('r1', 'get_system_status', 'succeeded', NULL, now() - interval '1 hour', now() - interval '1 hour', 'claude'),
  ('r2', 'list_failed_jobs', 'failed', 'timeout', now() - interval '2 hours', now() - interval '2 hours', 'claude');

-- workflow_runs: one completed, one running
INSERT INTO public.workflow_runs (intent, status, current_stage, updated_at) VALUES
  ('tax_return', 'completed', 'done', now() - interval '1 day'),
  ('tax_return', 'running', 'load_state', now() - interval '10 minutes');

-- KPI source data
INSERT INTO public.tax_returns (client_id, tax_year, status, filed_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 2024, 'filed', now() - interval '40 days'),
  ('11111111-1111-1111-1111-111111111111', 2025, 'draft', NULL),
  ('22222222-2222-2222-2222-222222222222', 2025, 'in_review', NULL);

INSERT INTO public.dispute_letters (client_id, bureau, status) VALUES
  ('22222222-2222-2222-2222-222222222222', 'experian', 'generated');

INSERT INTO public.marketing_spend (platform, spend, conversions, date) VALUES
  ('meta', 250.00, 4, (now() - interval '3 days')::date),
  ('meta', 125.50, 1, (now() - interval '10 days')::date),
  ('meta', 999.00, 9, (now() - interval '90 days')::date);  -- outside the 30d window

INSERT INTO public.pitch_drafts (channel, status, created_at) VALUES
  ('email', 'sent', now() - interval '2 days');
INSERT INTO public.playlist_research (artist_name, track_name, created_at) VALUES
  ('Fendi Frost', 'Test Track', now() - interval '5 days');
