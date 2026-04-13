
CREATE TABLE public.workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text,
  client_name text,
  tax_year integer,
  intent text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  current_stage text NOT NULL DEFAULT 'load_state',
  locked_state jsonb DEFAULT '{}'::jsonb,
  result_payload jsonb,
  error jsonb,
  statement_job_ids jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflow_runs_client_name ON public.workflow_runs (client_name);
CREATE INDEX idx_workflow_runs_tax_year ON public.workflow_runs (tax_year);
CREATE INDEX idx_workflow_runs_status ON public.workflow_runs (status);
CREATE INDEX idx_workflow_runs_current_stage ON public.workflow_runs (current_stage);

CREATE TRIGGER update_workflow_runs_updated_at
  BEFORE UPDATE ON public.workflow_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.workflow_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read access"
  ON public.workflow_runs FOR SELECT TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Service role full access"
  ON public.workflow_runs FOR ALL TO service_role
  USING (true) WITH CHECK (true);
