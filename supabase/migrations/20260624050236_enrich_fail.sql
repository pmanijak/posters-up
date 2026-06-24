-- ============================================================
-- Migration: enrichment_status column
--
-- Distinguishes enrichment outcomes that previously both stored
-- enrichment_data = null:
--   null       — never attempted (eligible for queue)
--   'complete' — ran successfully; enrichment_data may or may
--                not have content (null = found nothing)
--   'failed'   — API error, out of funds, parse failure, etc.
--                Safe to re-queue after fixing the underlying issue.
--
-- The queue filter (enrichment_attempted_at IS NULL) is unchanged.
-- enrichment_status is purely diagnostic — it does not gate the queue.
-- ============================================================

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS enrichment_status TEXT;

COMMENT ON COLUMN events.enrichment_status IS
  'Outcome of last enrichment attempt. '
  'null = never attempted. '
  'complete = ran successfully (enrichment_data may still be null if nothing found). '
  'failed = API error, out of funds, or parse failure — safe to re-queue.';

-- Backfill existing records.
-- Events with enrichment_source set on a sighting = complete.
-- Events with enrichment_attempted_at set but no sighting source = failed.
UPDATE events e
SET enrichment_status = 'complete'
WHERE e.enrichment_attempted_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM event_sightings es
    WHERE es.event_id = e.id
      AND es.enrichment_source IS NOT NULL
  );

UPDATE events e
SET enrichment_status = 'failed'
WHERE e.enrichment_attempted_at IS NOT NULL
  AND e.enrichment_status IS NULL;

-- Convenience index for finding failures to re-queue
CREATE INDEX IF NOT EXISTS idx_events_enrichment_status
  ON events(enrichment_status)
  WHERE enrichment_status IS NOT NULL;