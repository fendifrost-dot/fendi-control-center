ALTER TABLE public.credit_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispute_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playlist_research ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pitch_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated full access" ON public.credit_analyses FOR ALL TO public USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated full access" ON public.dispute_letters FOR ALL TO public USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated full access" ON public.playlist_research FOR ALL TO public USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated full access" ON public.pitch_drafts FOR ALL TO public USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);