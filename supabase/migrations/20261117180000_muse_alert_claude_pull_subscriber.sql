-- Pull subscriber for the Control Center MCP when the OAuth client is Claude.
-- Same shape as the seeded chatgpt row: audit role, pull delivery, no webhook.
-- The alias is the lowercase agent key. claude-code already owns the display
-- alias 'Claude'; this row does not add that string.
-- Idempotent: a second run inserts nothing.

insert into public.muse_alert_subscribers (agent_key, roles, aliases, delivery, enabled)
values ('claude', array['audit']::text[], array['claude']::text[], 'pull', true)
on conflict (agent_key) do nothing;
