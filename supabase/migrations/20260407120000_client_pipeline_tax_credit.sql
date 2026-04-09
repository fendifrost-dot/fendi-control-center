-- Separate tax vs credit client folders for Drive-backed clients.
-- Tax generator and tax ingestion should only see tax workspace folders.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS client_pipeline text NOT NULL DEFAULT 'unknown';

ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_client_pipeline_check;
ALTER TABLE public.clients
  ADD CONSTRAINT clients_client_pipeline_check
  CHECK (client_pipeline IN ('unknown', 'tax', 'credit', 'both'));

COMMENT ON COLUMN public.clients.client_pipeline IS
  'tax = TAXES-only Drive folder; credit = CREDIT-only; both = ambiguous name; unknown = manual/legacy';

-- Backfill from folder name heuristics
UPDATE public.clients
SET client_pipeline = 'tax'
WHERE upper(trim(name)) LIKE '%TAXES%'
  AND upper(trim(name)) NOT LIKE '%CREDIT%';

UPDATE public.clients
SET client_pipeline = 'credit'
WHERE upper(trim(name)) LIKE '%CREDIT%'
  AND upper(trim(name)) NOT LIKE '%TAXES%';

UPDATE public.clients
SET client_pipeline = 'both'
WHERE upper(trim(name)) LIKE '%CREDIT%'
  AND upper(trim(name)) LIKE '%TAXES%';

CREATE INDEX IF NOT EXISTS idx_clients_pipeline ON public.clients (client_pipeline);
