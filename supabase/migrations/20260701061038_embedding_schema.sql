ALTER TABLE events
  ADD COLUMN embedding_attempted_at  TIMESTAMPTZ,
  ADD COLUMN embedding_attempt_count INT  NOT NULL DEFAULT 0,
  ADD COLUMN embedding_status        TEXT;

CREATE INDEX idx_events_embedding_queue ON events(embedding_attempted_at)
  WHERE embedding_attempted_at IS NULL AND search_text IS NOT NULL;