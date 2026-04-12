-- Enable pgvector in extensions schema
CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;

-- Now create the RPC with search_path including extensions
CREATE OR REPLACE FUNCTION public.match_credit_knowledge(
  query_embedding vector(1536),
  match_threshold FLOAT DEFAULT 0.5,
  match_count INT DEFAULT 10,
  filter_type TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  type TEXT,
  content TEXT,
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ckb.id,
    ckb.type,
    ckb.content,
    ckb.metadata,
    (1 - (ckb.embedding <=> query_embedding))::FLOAT AS similarity
  FROM public.credit_knowledge_base ckb
  WHERE
    ckb.embedding IS NOT NULL
    AND (1 - (ckb.embedding <=> query_embedding)) > match_threshold
    AND (filter_type IS NULL OR ckb.type = filter_type)
  ORDER BY ckb.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;