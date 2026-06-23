-- ============================================================
-- Migration: richer enrichment support
-- Adds enrichment_attempt_count to events, replaces the inline
-- enrichment_attempted_at update with an atomic RPC, and finalizes
-- the conditional re-queue logic.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Track attempt count on events
--
-- Used for model selection in the enrich function:
--   count = 0  → Sonnet  (first pass: narrative writing, full research)
--   count > 0  → Haiku   (re-enrichment: checking whether new signal
--                          changes results; structured lookup, not writing)
--
-- Count is never reset by maybe_reenqueue_enrichment — it accumulates
-- across the lifetime of the event so we always know how many times
-- we've paid for a search.
-- ------------------------------------------------------------

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS enrichment_attempt_count INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN events.enrichment_attempt_count IS
  'Total enrichment attempts ever made for this event. '
  'Never reset. Used by enrich to select model: 0 = Sonnet, >0 = Haiku.';


-- ------------------------------------------------------------
-- 2. mark_enrichment_attempted()
--
-- Replaces the inline .update({ enrichment_attempted_at: now() })
-- in enrich/index.ts. Stamps the timestamp and increments the count
-- atomically in one round-trip.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION mark_enrichment_attempted(p_event_id UUID)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE events SET
    enrichment_attempted_at  = now(),
    enrichment_attempt_count = enrichment_attempt_count + 1
  WHERE id = p_event_id;
$$;

GRANT EXECUTE ON FUNCTION mark_enrichment_attempted(UUID) TO service_role;


-- ------------------------------------------------------------
-- 3. maybe_reenqueue_enrichment() — finalized signature
--
-- Re-queues an already-enriched event only when the new sighting
-- brings signal that would produce a different search result.
--
-- Gate 1 — verified: if ≥1 verification exists, a correct local
--   source was already found. Stop paying to re-search.
--
-- Gate 2 — new signal: re-queue only when the incoming sighting
--   fills or improves a field that meaningfully changes what
--   Claude can search for:
--
--   event_url   IS DISTINCT FROM existing  — any URL change is additive;
--                                            strongest anchor for dedup
--   description IS DISTINCT FROM existing  — richer description = better
--                                            search; last-non-null-wins
--                                            in extract, so a new
--                                            description is always ≥ old
--   location_name  existing IS NULL        — fills a gap; a different
--                                            value is ambiguous (bad read
--                                            vs correction), so only
--                                            null→value is safe to act on
--   date_start     existing IS NULL        — same reasoning as location
--
-- Returns true if re-queued, false if skipped.
-- ------------------------------------------------------------

-- Drop the old 2-parameter signature — CREATE OR REPLACE treats different
-- parameter lists as different functions and would leave a dead overload.
DROP FUNCTION IF EXISTS maybe_reenqueue_enrichment(UUID, TEXT);

CREATE OR REPLACE FUNCTION maybe_reenqueue_enrichment(
  p_event_id        UUID,
  p_new_event_url   TEXT DEFAULT NULL,
  p_new_location    TEXT DEFAULT NULL,
  p_new_date_start  DATE DEFAULT NULL,
  p_new_description TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_verification_count  INT;
  v_existing            RECORD;
BEGIN
  -- Gate 1: already verified — don't re-search
  SELECT COUNT(*) INTO v_verification_count
  FROM event_verifications
  WHERE event_id = p_event_id;

  IF v_verification_count > 0 THEN
    RETURN FALSE;
  END IF;

  -- Gate 2: only re-queue if new signal arrived
  SELECT event_url, location_name, date_start, description
  INTO v_existing
  FROM events WHERE id = p_event_id;

  IF (p_new_event_url   IS NOT NULL AND p_new_event_url   IS DISTINCT FROM v_existing.event_url)
  OR (p_new_description IS NOT NULL AND p_new_description IS DISTINCT FROM v_existing.description)
  OR (p_new_location    IS NOT NULL AND v_existing.location_name IS NULL)
  OR (p_new_date_start  IS NOT NULL AND v_existing.date_start    IS NULL)
  THEN
    UPDATE events
    SET enrichment_attempted_at = NULL
    WHERE id = p_event_id;
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;

GRANT EXECUTE ON FUNCTION maybe_reenqueue_enrichment(UUID, TEXT, TEXT, DATE, TEXT) TO service_role;