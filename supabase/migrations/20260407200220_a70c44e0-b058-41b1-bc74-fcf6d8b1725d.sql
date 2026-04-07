
-- Add client_pipeline column to clients
ALTER TABLE public.clients
ADD COLUMN IF NOT EXISTS client_pipeline text NOT NULL DEFAULT 'unknown';

-- Backfill based on client name patterns
UPDATE public.clients
SET client_pipeline = CASE
  WHEN UPPER(name) LIKE '%CREDIT%' AND UPPER(name) LIKE '%TAX%' THEN 'both'
  WHEN UPPER(name) LIKE '%CREDIT%' THEN 'credit'
  WHEN UPPER(name) LIKE '%TAX%' THEN 'tax'
  ELSE 'unknown'
END
WHERE client_pipeline = 'unknown';
