-- ============================================================
-- MIGRATION: confirm_talent_from_sighting()
-- ============================================================
--
-- Called by extract after every matched-event sighting (matchType
-- != 'none'), before the talent upserts for the current sighting.
-- Running before the upserts means we only confirm rows that existed
-- prior to this photo -- not ones we're about to create from it.
--
-- For each incoming talent name, finds unconfirmed event_talent rows
-- on this event whose talent.canonical_name matches at pg_trgm
-- similarity >= 0.85 and flips confirmed = true.
--
-- Returns the number of rows confirmed (used for logging).
-- ============================================================

CREATE OR REPLACE FUNCTION confirm_talent_from_sighting(
  p_event_id              UUID,
  p_incoming_talent_names TEXT[]
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE event_talent et
  SET confirmed = true
  FROM talent t,
       unnest(p_incoming_talent_names) AS incoming(name)
  WHERE et.event_id  = p_event_id
    AND et.talent_id = t.id
    AND et.confirmed = false
    AND similarity(t.canonical_name, lower(trim(incoming.name))) >= 0.85;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;