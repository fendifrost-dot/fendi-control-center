
-- Table to store connected project references
CREATE TABLE public.connected_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  supabase_url text NOT NULL,
  secret_key_name text NOT NULL, -- name of the secret holding the service role key
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.connected_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated full access" ON public.connected_projects
  FOR ALL USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);
