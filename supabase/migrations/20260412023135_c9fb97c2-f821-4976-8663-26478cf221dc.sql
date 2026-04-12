
-- Enable pgvector if not already
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- Create the knowledge base table
CREATE TABLE IF NOT EXISTS public.credit_knowledge_base (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('dispute_example', 'analysis_pattern', 'violation_logic')),
  case_type TEXT,
  trigger TEXT,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  embedding extensions.vector(1536),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.credit_knowledge_base ENABLE ROW LEVEL SECURITY;

-- Service role only
CREATE POLICY "Service role full access on credit_knowledge_base"
  ON public.credit_knowledge_base
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Vector index (IVFFlat requires at least some rows; lists=1 is safe for small tables)
CREATE INDEX IF NOT EXISTS idx_credit_knowledge_base_embedding
  ON public.credit_knowledge_base
  USING ivfflat (embedding extensions.vector_cosine_ops)
  WITH (lists = 1);

-- Drop existing function if signature changed
DROP FUNCTION IF EXISTS public.match_credit_knowledge(extensions.vector, double precision, integer, text);

-- Recreate match function
CREATE OR REPLACE FUNCTION public.match_credit_knowledge(
  query_embedding extensions.vector,
  match_threshold double precision DEFAULT 0.5,
  match_count integer DEFAULT 10,
  filter_type text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  type text,
  content text,
  metadata jsonb,
  similarity double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ckb.id,
    ckb.type,
    ckb.content,
    ckb.metadata,
    (1 - (ckb.embedding <=> query_embedding))::double precision AS similarity
  FROM public.credit_knowledge_base ckb
  WHERE
    ckb.embedding IS NOT NULL
    AND (1 - (ckb.embedding <=> query_embedding)) > match_threshold
    AND (filter_type IS NULL OR ckb.type = filter_type)
  ORDER BY ckb.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
