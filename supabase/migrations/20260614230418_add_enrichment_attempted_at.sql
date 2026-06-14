-- ============================================================
-- Migration: add enrichment_attempted_at to events
--
-- Tracks when web search enrichment was last attempted for an event,
-- regardless of whether it found anything. Used by the enrich queue
-- to avoid re-processing events that have already been attempted.
--
-- Null means "never attempted" — the event is eligible for enrichment.
-- Reset to null by the extract function when a new sighting comes in
-- for an existing event, which re-queues it for enrichment with the
-- new sighting's data as additional context.
-- ============================================================

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS enrichment_attempted_at TIMESTAMPTZ;

COMMENT ON COLUMN events.enrichment_attempted_at IS
  'When web search enrichment was last attempted. Null = not yet attempted (eligible for queue). '
  'Reset to null by extract when a new sighting arrives, triggering re-enrichment.';

CREATE INDEX idx_events_enrichment_attempted
  ON events (enrichment_attempted_at)
  WHERE enrichment_attempted_at IS NULL;