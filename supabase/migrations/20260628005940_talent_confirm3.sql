-- ============================================================
-- Migration: relax talent confirmation to same-board / different-day
--
-- Original: required a sighting from a *different board* before
-- confirming talent. New rule: any prior sighting is sufficient —
-- same board on a different day is independent signal (different
-- photographer, different lighting, fresh extraction pass).
--
-- p_new_board_id parameter removed from the function signature.
-- Update the extract Edge Function call site accordingly.
-- ============================================================

CREATE OR REPLACE FUNCTION confirm_talent_from_sighting(
  p_event_id             UUID,
  p_incoming_talent_names TEXT[]
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_prior_sighting_count INT;
  v_incoming_name        TEXT;
  v_match_talent_id      UUID;
  v_confirmed_count      INT := 0;
BEGIN
  -- Step 1: has this event been seen at least once before this sighting?
  -- Any prior sighting counts — same board on a different day is
  -- independent signal (fresh extraction, different conditions).
  SELECT COUNT(*)
  INTO v_prior_sighting_count
  FROM event_sightings
  WHERE event_id = p_event_id;

  IF v_prior_sighting_count = 0 THEN
    -- First sighting ever — nothing to confirm against.
    RETURN 0;
  END IF;

  -- Step 2: for each incoming name, find the best matching unconfirmed
  -- talent row on this event and confirm it.
  FOREACH v_incoming_name IN ARRAY p_incoming_talent_names LOOP
    SELECT et.talent_id
    INTO v_match_talent_id
    FROM event_talent et
    JOIN talent t ON t.id = et.talent_id
    WHERE et.event_id  = p_event_id
      AND et.confirmed = false
      AND similarity(lower(t.canonical_name), lower(v_incoming_name)) >= 0.85
    ORDER BY similarity(lower(t.canonical_name), lower(v_incoming_name)) DESC
    LIMIT 1;

    IF v_match_talent_id IS NOT NULL THEN
      UPDATE event_talent
      SET confirmed = true
      WHERE event_id  = p_event_id
        AND talent_id = v_match_talent_id;

      v_confirmed_count := v_confirmed_count + 1;
    END IF;
  END LOOP;

  RETURN v_confirmed_count;
END;
$$;

GRANT EXECUTE ON FUNCTION confirm_talent_from_sighting(UUID, TEXT[]) TO service_role;

-- Revoke the old signature so stale call sites fail loudly rather than
-- silently calling the wrong overload.
REVOKE EXECUTE ON FUNCTION confirm_talent_from_sighting(UUID, UUID, TEXT[]) FROM service_role;
DROP FUNCTION IF EXISTS confirm_talent_from_sighting(UUID, UUID, TEXT[]);