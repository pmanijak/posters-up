CREATE OR REPLACE FUNCTION mark_embedding_attempted(p_event_id UUID)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE events SET
    embedding_attempted_at  = now(),
    embedding_attempt_count = embedding_attempt_count + 1
  WHERE id = p_event_id;
$$;

GRANT EXECUTE ON FUNCTION mark_embedding_attempted(UUID) TO service_role;