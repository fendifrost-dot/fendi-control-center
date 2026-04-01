-- =============================================================================
-- CC Tax Workflows Migration
-- Applies to: fendi-control-center / supabase/migrations/
-- Filename:   20260326000000_tax_workflows.sql
--
-- What this does:
--   1. Inserts 5 CC Tax workflow entries into public.workflows
--   2. Tools arrays reference query_cc_tax (added via code patch) and
--      query_credit_guardian as fallback
--   3. Extends free_agent tools with cc_tax tool
-- =============================================================================

INSERT INTO public.workflows (key, name, description, trigger_phrases, tools)
VALUES
  (
    'get_tax_status',
    'Get Tax Year Status',
    'Retrieves the current tax year workflow status from CC Tax, including which workflow gates are open or blocked, unresolved counts, and overall federal/state return status.',
    '["tax status", "tax year status", "tax workflow", "where are we on taxes", "tax progress", "federal status", "state return status", "tax gates", "tax filing status", "how are taxes going", "tax year progress", "return status"]'::jsonb,
    '["query_cc_tax"]'::jsonb
  ),
  (
    'get_tax_transactions',
    'Get Tax Transactions',
    'Retrieves transaction and expense data from CC Tax for a given tax year, including deductible items, items requiring decisions, and reconciliation status.',
    '["tax transactions", "tax expenses", "deductible expenses", "schedule c expenses", "business expenses", "unresolved transactions", "expense list", "tax deductions", "transactions for taxes", "deductible items", "expense tracker"]'::jsonb,
    '["query_cc_tax"]'::jsonb
  ),
  (
    'get_tax_documents',
    'Get Tax Documents',
    'Retrieves the document status from CC Tax — which forms have been uploaded (W-2s, 1099s, bank statements), which are missing, and their verification status.',
    '["tax documents", "tax forms", "missing documents", "w2 uploaded", "1099 uploaded", "bank statement uploaded", "document status", "required forms", "tax uploads", "missing forms", "document verification"]'::jsonb,
    '["query_cc_tax"]'::jsonb
  ),
  (
    'get_tax_discrepancies',
    'Get Tax Discrepancies',
    'Retrieves discrepancies flagged in CC Tax — amount mismatches, missing documents, year mismatches, unmatched deposits, and their severity and resolution status.',
    '["tax discrepancies", "tax issues", "unresolved issues", "amount mismatch", "missing document discrepancy", "unmatched deposit", "tax flags", "critical tax issues", "discrepancy report", "tax errors", "reconciliation issues"]'::jsonb,
    '["query_cc_tax"]'::jsonb
  ),
  (
    'query_cc_tax',
    'Query CC Tax',
    'Directly queries CC Tax (taxgenerator project) for any tax data — year configuration, documents, transactions, evidence, invoices, income reconciliation, discrepancies, and workflow gates.',
    '["cc tax", "tax generator", "taxgenerator", "tax data", "tax query", "tax year config", "tax invoices", "income reconciliation", "tax evidence", "audit pack", "tax report", "p&l report", "profit and loss taxes"]'::jsonb,
    '["query_cc_tax"]'::jsonb
  )
ON CONFLICT (key) DO UPDATE SET
  name           = EXCLUDED.name,
  description    = EXCLUDED.description,
  trigger_phrases = EXCLUDED.trigger_phrases,
  tools          = EXCLUDED.tools,
  updated_at     = now();

-- ──────────────────────────────────────────────────────────────────────────────
-- Extend free_agent workflow to include cc_tax tool.
-- No-op if free_agent row does not exist.
-- ──────────────────────────────────────────────────────────────────────────────
UPDATE public.workflows
SET
  tools = (
    SELECT jsonb_agg(DISTINCT elem)
    FROM (
      SELECT elem FROM jsonb_array_elements(tools)          AS t(elem)
      UNION
      SELECT elem FROM jsonb_array_elements(
        '["query_cc_tax"]'::jsonb
      ) AS t(elem)
    ) merged
  ),
  updated_at = now()
WHERE key = 'free_agent';
