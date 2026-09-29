-- Enforce the work feed's stated append-only semantics for signed-in operators.
-- Service role retains full access for controlled backend workflows.

DROP POLICY IF EXISTS "Authenticated full access" ON public.muse_work_updates;
DROP POLICY IF EXISTS "Authenticated read work updates" ON public.muse_work_updates;
DROP POLICY IF EXISTS "Authenticated append work updates" ON public.muse_work_updates;

CREATE POLICY "Authenticated read work updates" ON public.muse_work_updates
  FOR SELECT TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated append work updates" ON public.muse_work_updates
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

REVOKE UPDATE, DELETE ON public.muse_work_updates FROM authenticated;
GRANT SELECT, INSERT ON public.muse_work_updates TO authenticated;

COMMENT ON TABLE public.muse_work_updates IS
  'Append-only coordination feed. Signed-in operators may read/append but not rewrite history; service role is reserved for controlled backend workflows.';

COMMENT ON VIEW public.muse_improvement_ledger IS
  'Continuous 1% ledger supporting daily interventions and longer measurement cycles; unverified claims never become measured results.';
