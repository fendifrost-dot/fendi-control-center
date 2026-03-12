CREATE OR REPLACE FUNCTION public.list_workflows()
RETURNS TABLE (
  key text,
  name text,
  description text,
  trigger_phrases jsonb,
  tools jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.key, w.name, w.description, w.trigger_phrases, w.tools
  FROM public.workflows w
  ORDER BY w.key;
$$;