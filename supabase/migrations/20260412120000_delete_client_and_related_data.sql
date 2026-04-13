-- Ordered delete for dashboard "remove client" — clears credit + tax rows before clients row.
-- SECURITY DEFINER bypasses RLS so authenticated users can run one controlled operation.

CREATE OR REPLACE FUNCTION public.delete_client_and_related_data(p_client_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id = p_client_id) THEN
    RAISE EXCEPTION 'Client not found';
  END IF;

  -- Telegram / approval queue (no FK to clients — delete explicitly)
  DELETE FROM public.telegram_approval_queue WHERE client_id = p_client_id;

  -- Audit logs keep rows; drop client link
  UPDATE public.audit_logs SET client_id = NULL WHERE client_id = p_client_id;

  -- Document self-references among this client's files
  UPDATE public.documents d
  SET replaced_by_document_id = NULL
  WHERE d.replaced_by_document_id IN (SELECT id FROM public.documents WHERE client_id = p_client_id);

  DELETE FROM public.extracted_pages
  WHERE document_id IN (SELECT id FROM public.documents WHERE client_id = p_client_id);

  DELETE FROM public.observations WHERE client_id = p_client_id;

  DELETE FROM public.ingestion_jobs
  WHERE client_id = p_client_id
     OR document_id IN (SELECT id FROM public.documents WHERE client_id = p_client_id);

  DELETE FROM public.conflicts WHERE client_id = p_client_id;

  DELETE FROM public.documents WHERE client_id = p_client_id;

  DELETE FROM public.drive_sync_events WHERE client_id = p_client_id;

  -- tax_returns.client_id is TEXT (UUID string or legacy name)
  DELETE FROM public.tax_returns WHERE client_id = p_client_id::text;

  DELETE FROM public.marketing_spend WHERE client_id = p_client_id;

  -- credit_analyses / dispute_letters: column type may be uuid or text across deployments
  DELETE FROM public.dispute_letters WHERE client_id::text = p_client_id::text;
  DELETE FROM public.credit_analyses WHERE client_id::text = p_client_id::text;

  -- client_aliases, credit_case_* have ON DELETE CASCADE from clients
  DELETE FROM public.clients WHERE id = p_client_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_client_and_related_data(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_client_and_related_data(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_client_and_related_data(uuid) TO service_role;

COMMENT ON FUNCTION public.delete_client_and_related_data(uuid) IS
  'Removes a client and dependent rows (documents, tax returns, marketing, credit analyses).';
