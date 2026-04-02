-- =============================================================================
-- Tax Engine Tables Migration
-- Applies to: fendi-control-center / supabase/migrations/
-- Filename: 20260402120000_tax_engine_tables.sql
--
-- What this does:
-- 1. Creates tax_form_templates
-- 2. Creates tax_returns
-- 3. Creates tax_form_instances
-- 4. Creates tax_return_audit_log
-- 5. Enables RLS with authenticated-full-access policies
-- 6. Adds indexes for common query patterns
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.tax_form_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    form_type       TEXT NOT NULL,
    form_year       INTEGER NOT NULL,
    form_name       TEXT NOT NULL,
    description     TEXT,
    field_schema    JSONB DEFAULT '{}'::jsonb,
    pdf_template_url TEXT,
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(form_type, form_year)
);

CREATE TABLE IF NOT EXISTS public.tax_returns (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id               TEXT NOT NULL,
    client_name             TEXT,
    tax_year                INTEGER NOT NULL,
    status                  TEXT DEFAULT 'draft' CHECK (status IN (
                                'draft', 'gathering_docs', 'in_progress',
                                'documents_ready', 'review', 'filed', 'amended', 'archived'
                            )),
    filing_status           TEXT,
    json_summary            JSONB,
    worksheet               TEXT,
    filing_recommendation   JSONB,
    agi                     NUMERIC(12,2),
    total_income            NUMERIC(12,2),
    total_tax               NUMERIC(12,2),
    amount_owed_or_refund   NUMERIC(12,2),
    filing_readiness_score  INTEGER,
    filing_method           TEXT,
    filed_at                TIMESTAMPTZ,
    confirmation_number     TEXT,
    drive_folder_id         TEXT,
    drive_folder_url        TEXT,
    model                   TEXT DEFAULT 'claude-sonnet-4-20250514',
    notes                   TEXT,
    created_by              TEXT DEFAULT 'system',
    created_at              TIMESTAMPTZ DEFAULT now(),
    updated_at              TIMESTAMPTZ DEFAULT now(),
    UNIQUE(client_id, tax_year)
);

CREATE TABLE IF NOT EXISTS public.tax_form_instances (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tax_return_id   UUID NOT NULL REFERENCES public.tax_returns(id) ON DELETE CASCADE,
    template_id     UUID REFERENCES public.tax_form_templates(id),
    form_type       TEXT NOT NULL,
    form_year       INTEGER NOT NULL,
    status          TEXT DEFAULT 'pending' CHECK (status IN (
                        'pending', 'filled', 'reviewed', 'finalized', 'error'
                    )),
    field_data      JSONB DEFAULT '{}'::jsonb,
    pdf_url         TEXT,
    drive_file_id   TEXT,
    error_message   TEXT,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tax_return_audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tax_return_id   UUID NOT NULL REFERENCES public.tax_returns(id) ON DELETE CASCADE,
    action          TEXT NOT NULL,
    actor           TEXT DEFAULT 'system',
    old_values      JSONB,
    new_values      JSONB,
    metadata        JSONB,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tax_returns_client_year ON public.tax_returns(client_id, tax_year);
CREATE INDEX IF NOT EXISTS idx_tax_returns_status ON public.tax_returns(status);
CREATE INDEX IF NOT EXISTS idx_tax_form_instances_return ON public.tax_form_instances(tax_return_id);
CREATE INDEX IF NOT EXISTS idx_tax_form_instances_type ON public.tax_form_instances(form_type, form_year);
CREATE INDEX IF NOT EXISTS idx_tax_audit_return ON public.tax_return_audit_log(tax_return_id);
CREATE INDEX IF NOT EXISTS idx_tax_audit_action ON public.tax_return_audit_log(action);

ALTER TABLE public.tax_form_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_form_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_return_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated full access" ON public.tax_form_templates FOR ALL TO public USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated full access" ON public.tax_returns FOR ALL TO public USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated full access" ON public.tax_form_instances FOR ALL TO public USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated full access" ON public.tax_return_audit_log FOR ALL TO public USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Service role bypass" ON public.tax_form_templates FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON public.tax_returns FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON public.tax_form_instances FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON public.tax_return_audit_log FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.tax_form_templates (form_type, form_year, form_name, description) VALUES
    ('1040', 2022, 'Form 1040 - U.S. Individual Income Tax Return', 'Standard individual tax return'),
    ('1040', 2023, 'Form 1040 - U.S. Individual Income Tax Return', 'Standard individual tax return'),
    ('1040', 2024, 'Form 1040 - U.S. Individual Income Tax Return', 'Standard individual tax return'),
    ('1040', 2025, 'Form 1040 - U.S. Individual Income Tax Return', 'Standard individual tax return'),
    ('schedule_c', 2022, 'Schedule C - Profit or Loss From Business', 'Self-employment income and expenses'),
    ('schedule_c', 2023, 'Schedule C - Profit or Loss From Business', 'Self-employment income and expenses'),
    ('schedule_c', 2024, 'Schedule C - Profit or Loss From Business', 'Self-employment income and expenses'),
    ('schedule_c', 2025, 'Schedule C - Profit or Loss From Business', 'Self-employment income and expenses'),
    ('schedule_se', 2022, 'Schedule SE - Self-Employment Tax', 'Self-employment tax calculation'),
    ('schedule_se', 2023, 'Schedule SE - Self-Employment Tax', 'Self-employment tax calculation'),
    ('schedule_se', 2024, 'Schedule SE - Self-Employment Tax', 'Self-employment tax calculation'),
    ('schedule_se', 2025, 'Schedule SE - Self-Employment Tax', 'Self-employment tax calculation')
ON CONFLICT (form_type, form_year) DO NOTHING;
