-- ============================================================
-- Migration: talent confirmation pipeline
-- Adds confirm_talent_from_sighting() and updates events_public
-- to include confirmed in the talent JSON.
--
-- Depends on: event_talent.confirmed column (added in prior migration).
-- Run order matters: function first, then view rebuild.
-- ============================================================


-- ------------------------------------------------------------
-- CONFIRM TALENT FROM SIGHTING
-- Called by the extract Edge Function when a new sighting arrives
-- for an already-known event, BEFORE inserting new talent rows.
--
-- Logic:
--   1. Check whether this event has been sighted on any board
--      other than the incoming one. If not, there is no cross-board
--      signal yet — return 0 and do nothing.
--   2. For each name in p_incoming_talent_names, find unconfirmed
--      event_talent rows whose talent.canonical_name is sufficiently
--      similar (≥ 0.85). Flip confirmed = true on matches.
--
-- Why call BEFORE talent inserts:
--   Rows inserted in the same call are not independently confirmed —
--   they come from the same photo. Confirming only pre-existing rows
--   ensures the signal is genuinely cross-board.
--
-- Returns: count of rows newly confirmed.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION confirm_talent_from_sighting(
  p_event_id             UUID,
  p_new_board_id         UUID,
  p_incoming_talent_names TEXT[]
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_other_board_count  INT;
  v_incoming_name      TEXT;
  v_match_talent_id    UUID;
  v_confirmed_count    INT := 0;
BEGIN
  -- Step 1: is there any prior sighting of this event from a different board?
  SELECT COUNT(DISTINCT board_id)
  INTO v_other_board_count
  FROM event_sightings
  WHERE event_id = p_event_id
    AND board_id IS NOT NULL
    AND board_id IS DISTINCT FROM p_new_board_id;

  IF v_other_board_count = 0 THEN
    -- First sighting, or same board revisiting — no cross-board signal yet.
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

GRANT EXECUTE ON FUNCTION confirm_talent_from_sighting(UUID, UUID, TEXT[]) TO service_role;


-- ------------------------------------------------------------
-- EVENTS_PUBLIC VIEW REBUILD
-- Adds 'confirmed' to the per-talent JSONB object.
--
-- events_for_boards() returns SETOF events_public, so it must be
-- dropped and recreated whenever events_public's column list changes.
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS events_for_boards(uuid[]);
DROP VIEW IF EXISTS events_public;

-- Consumer-facing event feed.
-- embedding excluded — internal to pipeline.
-- events_for_boards() returns SETOF events_public and must be dropped
-- before this view if the column list changes.
CREATE VIEW events_public AS
SELECT
  e.id,
  e.name,
  e.content_type,
  e.event_category,
  e.tags,
  e.flyer_style,
  e.date_type,
  e.date_start,
  e.date_end,
  e.time_start,
  e.time_end,
  e.recurrence_rule,
  e.date_raw,
  e.location_name,
  e.location_address,
  e.location_geo,
  e.is_outdoor,
  e.description,
  e.contact,
  e.event_url,
  e.price_raw,
  e.is_free,
  e.age_restriction,
  e.is_public,
  e.language,
  e.accessibility,
  e.masks_required,
  e.rsvp_required,
  e.rsvp_url,
  e.search_text,
  e.confidence_score,
  e.confidence_breakdown,
  e.sighting_count,
  e.first_sighted_at,
  e.last_sighted_at,
  o.name              AS organization_name,
  o.website           AS organization_website,
  v.id                AS venue_id,
  v.name              AS venue_name,
  v.website           AS venue_website,
  v.address           AS venue_address,
  v.geolocation       AS venue_geo,
  v.accessibility     AS venue_accessibility,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',               t.id,
        'name',             t.name,
        'talent_type',      t.talent_type,
        'role',             et.role,
        'billing_position', et.billing_position,
        'confirmed',        et.confirmed        -- added: gates enrichment links/bios
      )
      ORDER BY COALESCE(et.billing_position, 9999)
    ) FILTER (WHERE t.id IS NOT NULL),
    '[]'::jsonb
  ) AS talent,
  e.has_enrichment     -- appended last; use DROP/CREATE if adding further columns
FROM events e
LEFT JOIN organizations o  ON o.id = e.organization_id
LEFT JOIN venues v         ON v.id = e.venue_id
LEFT JOIN event_talent et  ON et.event_id = e.id
LEFT JOIN talent t         ON t.id = et.talent_id
WHERE e.is_active = true
  AND e.confidence_score >= (SELECT value::FLOAT FROM config WHERE key = 'min_confidence_display')
GROUP BY e.id, o.name, o.website, v.id, v.name, v.website, v.address, v.geolocation, v.accessibility;

-- Re-create events_for_boards using the updated view definition.
CREATE OR REPLACE FUNCTION events_for_boards(board_ids uuid[])
RETURNS SETOF events_public
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT ep.*
  FROM events_public ep
  WHERE ep.id IN (
    SELECT event_id
    FROM board_flyers
    WHERE board_id = ANY(board_ids)
      AND is_active = true
  );
$$;

GRANT SELECT ON events_public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION events_for_boards(uuid[]) TO anon, authenticated, service_role;