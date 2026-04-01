CREATE TABLE IF NOT EXISTS public.client_aliases (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name TEXT,
  alias TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(client_id, alias)
);

ALTER TABLE public.client_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access on client_aliases"
  ON public.client_aliases FOR ALL USING (true) WITH CHECK (true);