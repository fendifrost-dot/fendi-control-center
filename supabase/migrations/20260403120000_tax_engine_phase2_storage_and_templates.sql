-- Phase 2: Supabase Storage for filled PDFs + core tax_form_templates (2022–2025, 5 forms).
-- PDF AcroForm names follow common IRS fillable layouts; re-verify with scripts/extract-irs-pdf-fields.ts.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'tax-filled-pdfs',
  'tax-filled-pdfs',
  false,
  52428800,
  ARRAY['application/pdf']::text[]
)
ON CONFLICT (id) DO NOTHING;

WITH
f1040_map AS (
  SELECT jsonb_build_object(
    'topmostSubform[0].Page1[0].f1_01[0]', 'client_info.first_name',
    'topmostSubform[0].Page1[0].f1_02[0]', 'client_info.last_name',
    'topmostSubform[0].Page1[0].f1_03[0]', 'client_info.ssn',
    'topmostSubform[0].Page1[0].Line1[0]', 'forms.f1040.page1.line1_wages',
    'topmostSubform[0].Page1[0].Line2b[0]', 'forms.f1040.page1.line2b_taxable_interest',
    'topmostSubform[0].Page1[0].Line8[0]', 'forms.f1040.page1.line8_other_income',
    'topmostSubform[0].Page1[0].Line9[0]', 'forms.f1040.page1.line9_total_income',
    'topmostSubform[0].Page1[0].Line11[0]', 'forms.f1040.page1.line11_agi',
    'topmostSubform[0].Page1[0].Line12[0]', 'forms.f1040.page1.line12_standard_deduction',
    'topmostSubform[0].Page1[0].Line15[0]', 'forms.f1040.page1.line15_taxable_income',
    'topmostSubform[0].Page2[0].Line16[0]', 'forms.f1040.page2.line16_tax',
    'topmostSubform[0].Page2[0].Line24[0]', 'forms.f1040.page2.line24_total_tax',
    'topmostSubform[0].Page2[0].Line33[0]', 'forms.f1040.page2.line33_total_payments',
    'topmostSubform[0].Page2[0].Line37[0]', 'forms.f1040.page2.line37_amount_owed'
  ) AS mapping
),
years AS (
  SELECT * FROM (VALUES (2022), (2023), (2024), (2025)) AS t(y)
)
INSERT INTO public.tax_form_templates (form_type, tax_year, irs_pdf_url, field_mapping, field_metadata)
SELECT 'f1040', y.y,
  format('https://www.irs.gov/pub/irs-prior/f1040--%s.pdf', y.y),
  f1040_map.mapping,
  jsonb_build_object('seed', 'phase2', 'form', 'f1040')
FROM years y, f1040_map
ON CONFLICT (form_type, tax_year) DO NOTHING;

WITH
sched_c_map AS (
  SELECT jsonb_build_object(
    'topmostSubform[0].Page1[0].f1_01[0]', 'forms.schedule_c.business_name',
    'topmostSubform[0].Page1[0].Line1[0]', 'forms.schedule_c.line1_gross_receipts',
    'topmostSubform[0].Page1[0].Line7[0]', 'forms.schedule_c.line7_gross_income',
    'topmostSubform[0].Page1[0].Line28[0]', 'forms.schedule_c.line28_total_expenses',
    'topmostSubform[0].Page1[0].Line31[0]', 'forms.schedule_c.line31_net_profit'
  ) AS mapping
),
years AS (SELECT * FROM (VALUES (2022), (2023), (2024), (2025)) AS t(y))
INSERT INTO public.tax_form_templates (form_type, tax_year, irs_pdf_url, field_mapping, field_metadata)
SELECT 'schedule_c', y.y,
  format('https://www.irs.gov/pub/irs-prior/f1040sc--%s.pdf', y.y),
  sched_c_map.mapping,
  jsonb_build_object('seed', 'phase2', 'form', 'schedule_c')
FROM years y, sched_c_map
ON CONFLICT (form_type, tax_year) DO NOTHING;

WITH
sched_se_map AS (
  SELECT jsonb_build_object(
    'topmostSubform[0].Page1[0].Line2[0]', 'forms.schedule_se.line2_net_earnings',
    'topmostSubform[0].Page1[0].Line3[0]', 'forms.schedule_se.line3_92_35_pct',
    'topmostSubform[0].Page1[0].Line4a[0]', 'forms.schedule_se.line4a_max_wage_base',
    'topmostSubform[0].Page1[0].Line10[0]', 'forms.schedule_se.line10_se_tax',
    'topmostSubform[0].Page1[0].Line13[0]', 'forms.schedule_se.line13_deductible_half'
  ) AS mapping
),
years AS (SELECT * FROM (VALUES (2022), (2023), (2024), (2025)) AS t(y))
INSERT INTO public.tax_form_templates (form_type, tax_year, irs_pdf_url, field_mapping, field_metadata)
SELECT 'schedule_se', y.y,
  format('https://www.irs.gov/pub/irs-prior/f1040sse--%s.pdf', y.y),
  sched_se_map.mapping,
  jsonb_build_object('seed', 'phase2', 'form', 'schedule_se')
FROM years y, sched_se_map
ON CONFLICT (form_type, tax_year) DO NOTHING;

WITH
sched_1_map AS (
  SELECT jsonb_build_object(
    'topmostSubform[0].Page1[0].Line15[0]', 'forms.schedule_1.line15_se_tax_deduction',
    'topmostSubform[0].Page1[0].Line26[0]', 'forms.schedule_1.line26_total_adjustments'
  ) AS mapping
),
years AS (SELECT * FROM (VALUES (2022), (2023), (2024), (2025)) AS t(y))
INSERT INTO public.tax_form_templates (form_type, tax_year, irs_pdf_url, field_mapping, field_metadata)
SELECT 'schedule_1', y.y,
  format('https://www.irs.gov/pub/irs-prior/f1040s1--%s.pdf', y.y),
  sched_1_map.mapping,
  jsonb_build_object('seed', 'phase2', 'form', 'schedule_1')
FROM years y, sched_1_map
ON CONFLICT (form_type, tax_year) DO NOTHING;

WITH
sched_2_map AS (
  SELECT jsonb_build_object(
    'topmostSubform[0].Page1[0].Line4[0]', 'forms.schedule_2.line4_se_tax',
    'topmostSubform[0].Page1[0].Line21[0]', 'forms.schedule_2.line21_total'
  ) AS mapping
),
years AS (SELECT * FROM (VALUES (2022), (2023), (2024), (2025)) AS t(y))
INSERT INTO public.tax_form_templates (form_type, tax_year, irs_pdf_url, field_mapping, field_metadata)
SELECT 'schedule_2', y.y,
  format('https://www.irs.gov/pub/irs-prior/f1040s2--%s.pdf', y.y),
  sched_2_map.mapping,
  jsonb_build_object('seed', 'phase2', 'form', 'schedule_2')
FROM years y, sched_2_map
ON CONFLICT (form_type, tax_year) DO NOTHING;
