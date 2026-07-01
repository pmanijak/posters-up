CREATE OR REPLACE FUNCTION search_events_semantic(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.3,
  match_count     int   DEFAULT 50
)
RETURNS SETOF events_public
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ep.*
  FROM events_public ep
  JOIN events e ON e.id = ep.id
  WHERE e.embedding IS NOT NULL
    AND 1 - (e.embedding <=> query_embedding) >= match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION search_events_semantic(vector, float, int) TO anon, authenticated, service_role;