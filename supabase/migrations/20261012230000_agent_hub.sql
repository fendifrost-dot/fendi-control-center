-- ============================================================================
-- AGENT HUB
-- Shared threads, reviews and handoffs between connected agents, on top of the
-- Muse workboard and the Mac remote bridge. Additive only: no existing table,
-- view, row or policy is rewritten. The remote_command_queue type check is
-- widened (old types kept) so the Mac bridge can run agent handoffs and iMessage.
-- ============================================================================

-- 1. Agent registry. One row per integration, described truthfully: what it
--    actually connects to, where its conversation state lives, how it is
--    authenticated and who pays. `availability` is the declared state; the
--    agent-hub function adds a computed effective state at read time.
CREATE TABLE IF NOT EXISTS public.agent_hub_agents (
  key                text PRIMARY KEY,
  display_name       text NOT NULL,
  kind               text NOT NULL
    CONSTRAINT agent_hub_agents_kind_check CHECK (kind IN ('agent_session','cli_agent','model_api','connector','human')),
  transport          text NOT NULL
    CONSTRAINT agent_hub_agents_transport_check CHECK (transport IN ('token_inbox','mac_bridge','edge_model_call','ui')),
  connects_to        text NOT NULL,
  conversation_state text NOT NULL,
  tool_access        text NOT NULL,
  auth               text NOT NULL,
  billing            text NOT NULL,
  availability       text NOT NULL DEFAULT 'awaiting_setup'
    CONSTRAINT agent_hub_agents_availability_check CHECK (availability IN ('live','awaiting_setup','unverified','disabled')),
  availability_note  text,
  token_label        text,          -- muse_api_tokens.label this agent authenticates as
  bridge_cli         text           -- 'claude' | 'cursor' | 'codex' for mac_bridge agents
    CONSTRAINT agent_hub_agents_bridge_cli_check CHECK (bridge_cli IS NULL OR bridge_cli IN ('claude','cursor','codex')),
  model              text,          -- model id for model_api agents
  secret_name        text,          -- Edge secret NAME (never the value) the model_api agent needs
  workboard_mirror   boolean NOT NULL DEFAULT false, -- also post handoffs to the Muse workboard
  last_seen_at       timestamptz,
  last_verified_at   timestamptz,
  sort_order         integer NOT NULL DEFAULT 100,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- 2. Threads: one conversation per project/task. May link to a Muse mission/task.
CREATE TABLE IF NOT EXISTS public.agent_hub_threads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL,
  project          text,
  mission_id       uuid REFERENCES public.muse_missions(id) ON DELETE SET NULL,
  task_id          uuid REFERENCES public.muse_improvement_tasks(id) ON DELETE SET NULL,
  primary_agent    text REFERENCES public.agent_hub_agents(key) ON UPDATE CASCADE,
  status           text NOT NULL DEFAULT 'OPEN'
    CONSTRAINT agent_hub_threads_status_check CHECK (status IN ('OPEN','WAITING_ON_AGENT','WAITING_ON_FENDI','DONE','ARCHIVED')),
  created_by       text NOT NULL,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_hub_threads_activity_idx ON public.agent_hub_threads (last_activity_at DESC);

-- 3. Messages: append-only. A revision is a new REVISION message replying to
--    the original, so the original work is never overwritten.
CREATE TABLE IF NOT EXISTS public.agent_hub_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    uuid NOT NULL REFERENCES public.agent_hub_threads(id) ON DELETE CASCADE,
  author       text NOT NULL,       -- agent key, or 'fendi'
  author_kind  text NOT NULL DEFAULT 'agent'
    CONSTRAINT agent_hub_messages_author_kind_check CHECK (author_kind IN ('agent','human','system')),
  kind         text NOT NULL DEFAULT 'MESSAGE'
    CONSTRAINT agent_hub_messages_kind_check CHECK (kind IN (
      'MESSAGE','WORK','REVIEW','REVISION','FEEDBACK','DECISION','SYSTEM','IMPORT')),
  body         text NOT NULL,
  reply_to     uuid REFERENCES public.agent_hub_messages(id) ON DELETE SET NULL,
  handoff_id   uuid,                -- handoff this message answers (FK added below)
  context      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- repo, commit_sha, files, evidence, source_app, external_url
  attachments  jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{name, mime, text?, storage_path?, url?, bytes?, sha256?}]
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_hub_messages_thread_idx ON public.agent_hub_messages (thread_id, created_at);

-- 4. Handoffs: "send this to that agent for review / feedback / a task".
--    `context` is the immutable packet the receiver was given.
CREATE TABLE IF NOT EXISTS public.agent_hub_handoffs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id           uuid NOT NULL REFERENCES public.agent_hub_threads(id) ON DELETE CASCADE,
  source_message_id   uuid REFERENCES public.agent_hub_messages(id) ON DELETE SET NULL,
  from_agent          text NOT NULL,
  to_agent            text NOT NULL REFERENCES public.agent_hub_agents(key) ON UPDATE CASCADE,
  purpose             text NOT NULL DEFAULT 'REVIEW'
    CONSTRAINT agent_hub_handoffs_purpose_check CHECK (purpose IN ('REVIEW','FEEDBACK','TASK','REVISE','QUESTION')),
  instructions        text,
  context             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'QUEUED'
    CONSTRAINT agent_hub_handoffs_status_check CHECK (status IN (
      'QUEUED','DELIVERED','IN_PROGRESS','RESPONDED','FAILED','CANCELLED')),
  delivery            jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_message_id uuid REFERENCES public.agent_hub_messages(id) ON DELETE SET NULL,
  error               text,
  requested_by        text NOT NULL,
  delivered_at        timestamptz,
  responded_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_hub_handoffs_inbox_idx ON public.agent_hub_handoffs (to_agent, status, created_at);
CREATE INDEX IF NOT EXISTS agent_hub_handoffs_thread_idx ON public.agent_hub_handoffs (thread_id, created_at);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_hub_messages_handoff_fk') THEN
    ALTER TABLE public.agent_hub_messages
      ADD CONSTRAINT agent_hub_messages_handoff_fk
      FOREIGN KEY (handoff_id) REFERENCES public.agent_hub_handoffs(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 5. External session ids so a CLI agent continues the same conversation per thread.
CREATE TABLE IF NOT EXISTS public.agent_hub_sessions (
  thread_id           uuid NOT NULL REFERENCES public.agent_hub_threads(id) ON DELETE CASCADE,
  agent_key           text NOT NULL REFERENCES public.agent_hub_agents(key) ON UPDATE CASCADE,
  external_session_id text NOT NULL,
  meta                jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, agent_key)
);

-- 6. Touch triggers (reuse the Muse helper).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_hub_agents','agent_hub_threads','agent_hub_handoffs'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.muse_touch_updated_at()', t || '_touch', t);
  END LOOP;
END $$;

-- 7. RLS: signed-in operator reads everything; all writes go through the
--    agent-hub edge function (service role), which enforces actor identity.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_hub_agents','agent_hub_threads','agent_hub_messages','agent_hub_handoffs','agent_hub_sessions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated read" ON public.%I', t);
    EXECUTE format('CREATE POLICY "Authenticated read" ON public.%I FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL)', t);
    EXECUTE format('DROP POLICY IF EXISTS "Service role full access" ON public.%I', t);
    EXECUTE format('CREATE POLICY "Service role full access" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

-- The agent-hub function never updates or deletes messages; corrections are new rows.
COMMENT ON TABLE public.agent_hub_messages IS
  'Append-only shared thread. Original work, reviews, revisions and Fendi decisions are separate rows; nothing is overwritten.';
COMMENT ON TABLE public.agent_hub_handoffs IS
  'One row per send-to-agent. context is the exact packet the receiving agent was given.';

-- 8. Private storage bucket for attachments uploaded from the phone.
INSERT INTO storage.buckets (id, name, public)
VALUES ('agent-hub', 'agent-hub', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "agent-hub authenticated read" ON storage.objects;
CREATE POLICY "agent-hub authenticated read" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'agent-hub' AND auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "agent-hub authenticated upload" ON storage.objects;
CREATE POLICY "agent-hub authenticated upload" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'agent-hub' AND auth.uid() IS NOT NULL);

-- 9. Mac bridge: allow the new command types. Old types are kept unchanged.
ALTER TABLE public.remote_command_queue DROP CONSTRAINT IF EXISTS remote_command_queue_type_check;
ALTER TABLE public.remote_command_queue
  ADD CONSTRAINT remote_command_queue_type_check
  CHECK (command_type IN (
    'shell','cursor_agent','claude','open_url','notify','ping',
    'agent_handoff','imessage_send','imessage_read','capabilities'));

-- 10. Workboard mission that carries handoffs to Grok Bot and Enki, so their
--     existing workboard routine sees them without a new read path.
INSERT INTO public.muse_missions (id, domain_key, title, objective, owner, priority, status, created_by, notes)
VALUES (
  'a9e3c1f0-6b2d-4c11-9d7e-0c0c0a9e7b01', 'ai_technical_systems',
  'Control Center agent handoffs',
  'Carry review and feedback handoffs from the Control Center Agent Hub to agents that read the Muse workboard.',
  'Fendi', 'P2', 'ACTIVE', 'agent-hub',
  'Each ASSIGNMENT here names an agent_hub_handoffs id. Respond through agent-hub action=respond, not on the workboard.'
)
ON CONFLICT (id) DO NOTHING;

-- 11. Registry seed. Declared availability is conservative; the function
--     computes the effective state (secret present, bridge heartbeat, last success).
INSERT INTO public.agent_hub_agents
  (key, display_name, kind, transport, connects_to, conversation_state, tool_access, auth, billing,
   availability, availability_note, token_label, bridge_cli, model, secret_name, workboard_mirror, sort_order)
VALUES
  ('fendi', 'Fendi', 'human', 'ui',
   'You, in the Control Center app (phone or desktop).',
   'Threads in Control Center.', 'Decisions, approvals, handoffs.', 'Control Center sign-in.', 'None.',
   'live', NULL, NULL, NULL, NULL, NULL, false, 0),

  ('grok-api', 'Grok (xAI API)', 'model_api', 'edge_model_call',
   'xAI chat completions API, called from the agent-hub edge function with the Frost_Grok key the Telegram bot already uses.',
   'Stateless per call. Control Center sends the handoff packet plus recent thread messages each time; nothing is kept at xAI between calls.',
   'None. Reads only the packet: it cannot open links, run code or browse the repo.',
   'Edge secret Frost_Grok.', 'Per-token, billed to the xAI account behind Frost_Grok.',
   'unverified', 'Becomes live after its first successful call from the hub.', NULL, NULL, 'grok-3-mini-fast', 'Frost_Grok', false, 10),

  ('openai-api', 'ChatGPT model (OpenAI API)', 'model_api', 'edge_model_call',
   'OpenAI chat completions API with OPENAI_API_KEY. This is the API, not your ChatGPT app account: it cannot see your ChatGPT conversations.',
   'Stateless per call; the hub resends the packet and recent thread messages.',
   'None. Reads only the packet.',
   'Edge secret OPENAI_API_KEY (if set).', 'Per-token, billed to the OpenAI API account behind OPENAI_API_KEY. Separate from a ChatGPT Plus subscription.',
   'unverified', 'Depends on OPENAI_API_KEY being set in Lovable Cloud secrets.', NULL, NULL, 'gpt-4o-mini', 'OPENAI_API_KEY', false, 20),

  ('grok-bot', 'Grok Bot', 'agent_session', 'token_inbox',
   'Your existing Grok Bot agent (its own workspace), which already reads and writes the Muse workboard with the grok-bot token.',
   'Lives in Grok Bot''s own session/workspace. Control Center holds the shared thread.',
   'Whatever Grok Bot already has (its own toolset, including launching Claude Code on your Mac).',
   'Muse token labelled grok-bot (workboard:write scope).', 'Grok Bot''s own runtime; no new billing.',
   'awaiting_setup', 'Handoffs are mirrored to the workboard. Grok Bot needs one directive to answer through agent-hub (see docs/AGENT_HUB.md).',
   'grok-bot', NULL, NULL, NULL, true, 30),

  ('enki', 'Enki (Muse)', 'agent_session', 'token_inbox',
   'Enki, the Muse executive agent, which reads the workboard with the enki token.',
   'Lives in Enki''s own runtime. Control Center holds the shared thread.',
   'Whatever Enki already has.',
   'Muse token labelled enki (workboard:write scope).', 'Enki''s own runtime; no new billing.',
   'awaiting_setup', 'Handoffs are mirrored to the workboard. Enki needs one directive to answer through agent-hub.',
   'enki', NULL, NULL, NULL, true, 40),

  ('claude-code-cloud', 'Claude Code (cloud session)', 'agent_session', 'token_inbox',
   'A Claude Code session on claude.ai (like the one that built this), acting through the agent-hub API with its own token.',
   'Lives in that claude.ai session. Control Center cannot wake a session; a session sees handoffs when it checks its inbox.',
   'That session''s tools: GitHub repo clone/push, Lovable, web.',
   'Muse token labelled claude-code-cloud (agenthub scope).', 'Your Claude Max subscription.',
   'unverified', NULL, 'claude-code-cloud', NULL, NULL, NULL, false, 50),

  ('claude-code-mac', 'Claude Code (your Mac)', 'cli_agent', 'mac_bridge',
   'The claude CLI on your Mac, run by the remote bridge (scripts/remote-bridge/run.mjs).',
   'Real Claude Code session on your Mac. The hub stores its session id per thread and resumes it (claude --resume), so follow-ups continue the same conversation.',
   'Claude Code tools in a checkout of the exact commit under review (read-only tools for reviews).',
   'Your Claude login on the Mac. The bridge strips ANTHROPIC_API_KEY so runs use Max, not the API.',
   'Your Claude Max subscription.',
   'awaiting_setup', 'Needs the updated bridge running on your Mac.', NULL, 'claude', NULL, NULL, false, 60),

  ('cursor-mac', 'Cursor agent (your Mac)', 'cli_agent', 'mac_bridge',
   'The Cursor agent CLI on your Mac, run by the remote bridge.',
   'Cursor chat on your Mac; resumed per thread when the CLI reports a session id.',
   'Cursor agent tools in the repo checkout.',
   'Your Cursor login on the Mac.', 'Your Cursor plan credits.',
   'awaiting_setup', 'Needs the updated bridge and Cursor credits.', NULL, 'cursor', NULL, NULL, false, 70),

  ('codex-mac', 'Codex CLI (your Mac)', 'cli_agent', 'mac_bridge',
   'OpenAI Codex CLI on your Mac, run by the remote bridge. Signed in with ChatGPT, it uses your ChatGPT plan.',
   'Codex session on your Mac; resumed per thread when possible.',
   'Codex tools in the repo checkout.',
   'Codex sign-in on your Mac (ChatGPT account or API key).', 'Your ChatGPT plan if signed in with ChatGPT; otherwise per-token API.',
   'awaiting_setup', 'Not installed or verified yet.', NULL, 'codex', NULL, NULL, false, 80)
ON CONFLICT (key) DO NOTHING;
