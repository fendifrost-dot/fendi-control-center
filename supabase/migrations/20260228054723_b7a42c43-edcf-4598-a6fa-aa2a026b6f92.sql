
-- Replace overly permissive policies with service-role-scoped ones
DROP POLICY "Service role full access" ON public.telegram_approval_queue;
DROP POLICY "Service role full access" ON public.bot_settings;

-- Edge functions use service role key which bypasses RLS entirely,
-- so these extra policies aren't needed. The auth.uid() policies handle dashboard access.
