-- Optional: remove clients that were created only for Credit Guardian (credit-workspace Drive folders).
-- Run ONLY after migration 20260407120000_client_pipeline_tax_credit.sql has been applied.
-- Backup the database first. If DELETE fails due to foreign keys, delete dependent rows first.

-- Preview:
-- SELECT id, name, client_pipeline, created_at FROM public.clients WHERE client_pipeline = 'credit' ORDER BY name;

-- Uncomment to execute:
-- DELETE FROM public.clients WHERE client_pipeline = 'credit';
