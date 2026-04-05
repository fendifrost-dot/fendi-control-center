-- Add list_tax_returns to free_agent tool set (see AGENT_TOOLS in telegram-webhook)
UPDATE public.workflows
SET
  tools = (
    SELECT jsonb_agg(DISTINCT elem)
    FROM (
      SELECT elem FROM jsonb_array_elements(tools) AS t(elem)
      UNION
      SELECT elem FROM jsonb_array_elements('["list_tax_returns"]'::jsonb) AS t(elem)
    ) merged
  ),
  updated_at = now()
WHERE key = 'free_agent';
