-- ============================================================================
-- OWNER-ONLY ACCESS
-- Review finding 1 (Agent Hub, 13 Oct 2026): every RLS policy admitted any
-- signed-in user, public signup is enabled on this project's auth API, and six
-- SECURITY DEFINER functions were executable by `anon`. A stranger who signed up
-- could read all clients, credit/tax data and Agent Hub threads, and anyone with
-- the public anon key could call the definer functions.
--
-- Fix: one explicit owner list, one helper, and every operator policy, storage
-- policy and definer function checks it. Service role (edge functions) unchanged.
-- Additive for data: no rows are changed or removed.
-- ============================================================================

-- 1. Owners. Seeded from the one real account; add more only deliberately.
CREATE TABLE IF NOT EXISTS public.control_center_owners (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      text NOT NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  note       text
);
ALTER TABLE public.control_center_owners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.control_center_owners FROM anon, authenticated;
DROP POLICY IF EXISTS "Service role full access" ON public.control_center_owners;
CREATE POLICY "Service role full access" ON public.control_center_owners
  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.control_center_owners (user_id, email, note)
SELECT id, email, 'Fendi — seeded by owner-only migration'
FROM auth.users WHERE lower(email) = 'fendifrost@gmail.com'
ON CONFLICT (user_id) DO NOTHING;

COMMENT ON TABLE public.control_center_owners IS
  'Accounts with operator authority over Control Center. Signing in is not enough; the user id must be listed here.';

-- 2. Helper used by every policy below and by the edge functions' own checks.
CREATE OR REPLACE FUNCTION public.is_control_center_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.control_center_owners o WHERE o.user_id = auth.uid());
$$;
REVOKE ALL ON FUNCTION public.is_control_center_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_control_center_owner() TO anon, authenticated, service_role;

-- 3. Rewrite every operator policy that only required "signed in".
--    Policy names, commands and roles stay as they were; only the condition changes.
DO $$
DECLARE
  p record;
  new_qual text;
  new_check text;
  stmt text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname IN ('public', 'storage')
      AND (coalesce(qual, '') LIKE '%auth.uid() IS NOT NULL%'
           OR coalesce(with_check, '') LIKE '%auth.uid() IS NOT NULL%')
  LOOP
    new_qual  := replace(p.qual,       'auth.uid() IS NOT NULL', 'public.is_control_center_owner()');
    new_check := replace(p.with_check, 'auth.uid() IS NOT NULL', 'public.is_control_center_owner()');
    stmt := format('ALTER POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
    IF new_qual IS NOT NULL THEN stmt := stmt || format(' USING (%s)', new_qual); END IF;
    IF new_check IS NOT NULL THEN stmt := stmt || format(' WITH CHECK (%s)', new_check); END IF;
    EXECUTE stmt;
  END LOOP;
END $$;

-- Policies that did not even require a login.
ALTER POLICY "Authenticated read access on workflows" ON public.workflows
  USING (public.is_control_center_owner());
ALTER POLICY "tax-documents authenticated select" ON storage.objects
  USING (bucket_id = 'tax-documents' AND public.is_control_center_owner());
ALTER POLICY "tax-source-documents authenticated select" ON storage.objects
  USING (bucket_id = 'tax-source-documents' AND public.is_control_center_owner());
ALTER POLICY "tax-source-documents authenticated insert" ON storage.objects
  WITH CHECK (bucket_id = 'tax-source-documents' AND public.is_control_center_owner());
ALTER POLICY "tax-source-documents authenticated update" ON storage.objects
  USING (bucket_id = 'tax-source-documents' AND public.is_control_center_owner())
  WITH CHECK (bucket_id = 'tax-source-documents' AND public.is_control_center_owner());
ALTER POLICY "tax-source-documents authenticated delete" ON storage.objects
  USING (bucket_id = 'tax-source-documents' AND public.is_control_center_owner());

-- 4. Views that ran with their creator's rights (bypassing RLS) and were readable by anon.
ALTER VIEW public.current_personal_info SET (security_invoker = true);
ALTER VIEW public.current_tradelines    SET (security_invoker = true);
ALTER VIEW public.current_inquiries     SET (security_invoker = true);

-- 5. anon never reads operator data. RLS already returned nothing; this removes the grant too.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

-- 6. SECURITY DEFINER functions: backend-only, except client deletion which the
--    owner runs from the Clients page and now checks ownership itself.
REVOKE EXECUTE ON FUNCTION public.claim_outbox_rows(text, integer, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_pending_guardian_events(integer, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_remote_command_rows(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.list_workflows() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.match_credit_knowledge(vector, double precision, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_outbox_rows(text, integer, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_pending_guardian_events(integer, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_remote_command_rows(uuid, integer, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_workflows() TO service_role;
GRANT EXECUTE ON FUNCTION public.match_credit_knowledge(vector, double precision, integer, text) TO service_role;

-- Keep the deletion body exactly as deployed; put an owner gate in front of it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'delete_client_and_related_data_impl') THEN
    ALTER FUNCTION public.delete_client_and_related_data(uuid) RENAME TO delete_client_and_related_data_impl;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.delete_client_and_related_data_impl(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_client_and_related_data_impl(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.delete_client_and_related_data(p_client_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' AND NOT public.is_control_center_owner() THEN
    RAISE EXCEPTION 'Only the Control Center owner can delete clients' USING ERRCODE = '42501';
  END IF;
  PERFORM public.delete_client_and_related_data_impl(p_client_id);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.delete_client_and_related_data(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_client_and_related_data(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.delete_client_and_related_data(uuid) IS
  'Owner-gated wrapper around delete_client_and_related_data_impl (the original ordered delete).';
