-- Deduplicate tax_returns rows where client_id was stored as a name string instead of a UUID.
--
-- Background: an older Telegram path inserted tax_returns with client_id = client_name (e.g. "Sam Higgins")
-- rather than the clients.id UUID.  The generate_tax_docs tool later inserted a second row with the real
-- UUID, leaving duplicates that differ only in client_id format.
--
-- This migration:
--   1. For each "name-string" row that has a matching UUID row (same client_name + tax_year),
--      copies any non-null fields from the name-string row into the UUID row (filling gaps like AGI),
--      then deletes the name-string row.
--   2. For name-string rows with NO matching UUID row, resolves the correct UUID from clients.name
--      and updates client_id in place; if no clients row is found, leaves the record untouched.

-- ── Step 1: patch UUID rows with AGI / totals from their name-string counterparts ────────────────
UPDATE public.tax_returns AS uuid_row
SET
  agi                   = COALESCE(uuid_row.agi,                   name_row.agi),
  total_income          = COALESCE(uuid_row.total_income,          name_row.total_income),
  total_tax             = COALESCE(uuid_row.total_tax,             name_row.total_tax),
  amount_owed_or_refund = COALESCE(uuid_row.amount_owed_or_refund, name_row.amount_owed_or_refund),
  filing_readiness_score= COALESCE(uuid_row.filing_readiness_score,name_row.filing_readiness_score),
  json_summary          = COALESCE(uuid_row.json_summary,          name_row.json_summary),
  worksheet             = COALESCE(uuid_row.worksheet,             name_row.worksheet),
  updated_at            = now()
FROM public.tax_returns AS name_row
WHERE
  -- uuid_row has a proper UUID client_id
  uuid_row.client_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  -- name_row has a non-UUID client_id (name string)
  AND name_row.client_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  -- same client and year
  AND lower(trim(uuid_row.client_name)) = lower(trim(name_row.client_name))
  AND uuid_row.tax_year = name_row.tax_year
  -- safety: don't update a row with itself
  AND uuid_row.id <> name_row.id;

-- ── Step 2: delete the now-redundant name-string rows ────────────────────────────────────────────
DELETE FROM public.tax_returns AS name_row
WHERE
  name_row.client_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND EXISTS (
    SELECT 1
    FROM public.tax_returns uuid_row
    WHERE
      uuid_row.client_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND lower(trim(uuid_row.client_name)) = lower(trim(name_row.client_name))
      AND uuid_row.tax_year = name_row.tax_year
      AND uuid_row.id <> name_row.id
  );

-- ── Step 3: for orphaned name-string rows, resolve UUID from clients table and update in place ───
UPDATE public.tax_returns AS tr
SET
  client_id  = c.id,
  updated_at = now()
FROM public.clients c
WHERE
  tr.client_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND lower(trim(c.name)) = lower(trim(tr.client_name));
