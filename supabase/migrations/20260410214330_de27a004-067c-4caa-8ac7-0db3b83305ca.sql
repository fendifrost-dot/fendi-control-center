UPDATE public.tax_returns
SET json_summary = jsonb_set(
  json_summary,
  '{manual_income}',
  (
    SELECT jsonb_agg(elem)
    FROM jsonb_array_elements(json_summary->'manual_income') AS elem
    WHERE elem->>'id' != '3af3c96d-e089-45da-9a5e-c8421bffd879'
  )
),
updated_at = now()
WHERE client_id = '55fbe4eb-8ae9-40b1-8080-3d97f85039cc'
  AND tax_year = 2022;