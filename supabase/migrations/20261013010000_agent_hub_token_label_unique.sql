-- Agent Hub review follow-up (thread 87e35184): a Muse token label must map to at most one agent,
-- so a token can never resolve to two identities. Applied live through Lovable SQL.
CREATE UNIQUE INDEX IF NOT EXISTS agent_hub_agents_token_label_key
  ON public.agent_hub_agents (token_label) WHERE token_label IS NOT NULL;
