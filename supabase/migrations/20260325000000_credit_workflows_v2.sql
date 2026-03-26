-- =============================================================================
-- Credit Workflows Migration (v2 — corrected)
-- Applies to: fendi-control-center / supabase/migrations/
-- Filename:   20260325000000_credit_workflows_v2.sql
--
-- What this does:
--   1. Inserts 4 credit workflow entries into public.workflows
--   2. Tools arrays only reference tools that currently EXIST in AGENT_TOOLS
--      (query_credit_guardian + query_credit_compass once code patch is applied)
--   3. Trigger phrases do NOT overlap with playlist/pitch keywords
--   4. Extends free_agent tools with credit tools (no-op if free_agent missing)
-- =============================================================================

INSERT INTO public.workflows (key, name, description, trigger_phrases, tools)
VALUES
  (
    'analyze_client_credit',
    'Analyze Client Credit',
    'Analyzes a client''s credit report, identifies negative items, provides improvement recommendations, and cross-references data across Credit Guardian and Credit Compass.',
    '["analyze credit", "credit report", "experian report", "transunion report", "equifax report", "credit analysis", "analyze credit for", "credit score", "negative items", "credit bureau", "check credit", "review credit", "credit profile", "credit standing"]'::jsonb,
    '["query_credit_guardian", "query_credit_compass"]'::jsonb
  ),
  (
    'get_client_report',
    'Get Client Credit Report',
    'Retrieves a client''s full credit report and assessment data from Credit Guardian and Credit Compass systems.',
    '["get credit report", "pull credit", "show credit report", "client report", "credit history", "credit file", "fetch report", "retrieve report", "show me the report", "client credit file"]'::jsonb,
    '["query_credit_guardian", "query_credit_compass"]'::jsonb
  ),
  (
    'generate_dispute_letters',
    'Generate Credit Dispute Letters',
    'Generates dispute letters targeting negative items on a client''s credit report using data from Credit Guardian.',
    '["dispute letter", "generate dispute", "write dispute", "dispute negative", "dispute items", "dispute collection", "dispute late payment", "dispute inquiry", "dispute account", "credit dispute", "create dispute"]'::jsonb,
    '["query_credit_guardian", "query_credit_compass"]'::jsonb
  ),
  (
    'query_credit_compass',
    'Query Credit Compass',
    'Directly queries Credit Compass (fendi-fight-plan) for credit assessment data, client records, dispute sessions, and credit strategy information.',
    '["credit compass", "credit assessment", "fight plan", "credit battle plan", "dispute session", "credit strategy", "assessment detail", "credit compass data"]'::jsonb,
    '["query_credit_compass", "query_credit_guardian"]'::jsonb
  )
ON CONFLICT (key) DO UPDATE SET
  name           = EXCLUDED.name,
  description    = EXCLUDED.description,
  trigger_phrases = EXCLUDED.trigger_phrases,
  tools          = EXCLUDED.tools,
  updated_at     = now();

-- ──────────────────────────────────────────────────────────────────────────────
-- Extend free_agent workflow to include credit tools.
-- This is a no-op if no 'free_agent' row exists yet.
-- ──────────────────────────────────────────────────────────────────────────────
UPDATE public.workflows
SET
  tools = (
    SELECT jsonb_agg(DISTINCT elem)
    FROM (
      SELECT elem FROM jsonb_array_elements(tools)          AS t(elem)
      UNION
      SELECT elem FROM jsonb_array_elements(
        '["query_credit_guardian", "query_credit_compass"]'::jsonb
      ) AS t(elem)
    ) merged
  ),
  updated_at = now()
WHERE key = 'free_agent';
