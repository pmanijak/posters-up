  -- ============================================================
-- Migration: fix find_event_match() normalized name filter
--
-- Bug: the WHERE candidate filter compared lower(e.name) against
-- v_norm_name (a normalized string), producing low trigram similarity
-- and filtering out valid matches before the real comparison ran.
-- Example: "No Hate! Festival — Protect Trans Youth" normalized to
-- "no hate festival protect trans youth" never matched the stored
-- raw name "No Hate! Festival — Protect Trans Youth" at the 0.60
-- threshold, so the match was dropped before the SELECT scored it.
--
-- Fix: normalize the stored name in the WHERE filter to match
-- what v_norm_name was already computing.
--
-- Also adds a functional GIN index on normalize_event_name(name)
-- so the % operator has index support. The existing index is on
-- lower(name) and does not help the normalized comparison.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Index first — function must exist before index is created,
--    and normalize_event_name() is already in the schema.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_events_name_normalized_trgm
  ON events USING GIN (normalize_event_name(name) gin_trgm_ops);


-- ------------------------------------------------------------
-- 2. Updated find_event_match() with corrected WHERE filter
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION find_event_match(
  p_name          TEXT,
  p_date_start    DATE,
  p_location_name TEXT,
  p_board_lat     FLOAT,
  p_board_lng     FLOAT,
  p_event_url     TEXT,
  p_talent_name   TEXT DEFAULT NULL
)
RETURNS event_match_result
LANGUAGE plpgsql
AS $$
DECLARE
  v_result     event_match_result;
  v_norm_name  TEXT;
  v_board_geo  GEOGRAPHY;
  v_match_id   UUID;
  v_name_sim   FLOAT;
  v_date_delta INT;
  v_loc_sim    FLOAT;
  v_board_dist FLOAT;
BEGIN

  -- Tier 1: URL hard match
  IF p_event_url IS NOT NULL THEN
    SELECT id INTO v_match_id
    FROM events
    WHERE event_url = p_event_url
      AND is_active = true
    LIMIT 1;

    IF v_match_id IS NOT NULL THEN
      v_result.match_id   := v_match_id;
      v_result.match_type := 'url';
      RETURN v_result;
    END IF;
  END IF;

  -- Tier 1.5: Talent anchor match
  IF p_talent_name IS NOT NULL THEN
    SELECT e.id INTO v_match_id
    FROM events e
    JOIN event_talent et ON et.event_id  = e.id AND et.billing_position = 1
    JOIN talent t        ON t.id         = et.talent_id
    WHERE e.is_active = true
      AND similarity(lower(t.canonical_name), lower(p_talent_name)) >= 0.80
      AND (
        p_date_start IS NULL
        OR e.date_start IS NULL
        OR ABS(e.date_start - p_date_start) <= 1
      )
      AND (
        p_location_name IS NULL
        OR e.location_name IS NULL
        OR similarity(lower(e.location_name), lower(p_location_name)) >= 0.60
      )
    ORDER BY similarity(lower(t.canonical_name), lower(p_talent_name)) DESC
    LIMIT 1;

    IF v_match_id IS NOT NULL THEN
      v_result.match_id   := v_match_id;
      v_result.match_type := 'talent_anchor';
      RETURN v_result;
    END IF;
  END IF;

  -- Tier 2: Fuzzy match — normalized name + date + location
  v_norm_name := normalize_event_name(p_name);

  IF p_board_lat IS NOT NULL AND p_board_lng IS NOT NULL THEN
    v_board_geo := ST_SetSRID(ST_MakePoint(p_board_lng, p_board_lat), 4326)::geography;
  END IF;

  PERFORM set_config('pg_trgm.similarity_threshold', '0.60', true);

  SELECT
    e.id,
    similarity(normalize_event_name(e.name), v_norm_name),
    CASE
      WHEN p_date_start IS NOT NULL AND e.date_start IS NOT NULL
      THEN ABS(e.date_start - p_date_start)
      ELSE NULL
    END,
    CASE
      WHEN p_location_name IS NOT NULL AND e.location_name IS NOT NULL
      THEN similarity(lower(e.location_name), lower(p_location_name))
      ELSE NULL
    END,
    CASE
      WHEN v_board_geo IS NOT NULL
      THEN MIN(ST_Distance(b.geolocation::geography, v_board_geo))
      ELSE NULL
    END
  INTO v_match_id, v_name_sim, v_date_delta, v_loc_sim, v_board_dist
  FROM events e
  LEFT JOIN event_sightings es ON es.event_id = e.id
  LEFT JOIN boards b           ON b.id = es.board_id AND b.geolocation IS NOT NULL
  WHERE e.is_active = true
    -- FIX: normalize the stored name before the % operator so both sides
    -- are in the same form. Previously compared raw lower(e.name) against
    -- the already-normalized v_norm_name, causing low similarity scores
    -- that filtered out valid candidates like "No Hate!" vs "No Hate".
    AND normalize_event_name(e.name) % v_norm_name
    AND (
      p_date_start IS NULL
      OR e.date_start IS NULL
      OR ABS(e.date_start - p_date_start) <= 2
    )
  GROUP BY e.id
  ORDER BY similarity(normalize_event_name(e.name), v_norm_name) DESC
  LIMIT 1;

  IF v_match_id IS NULL THEN
    v_result.match_type := 'none';
    RETURN v_result;
  END IF;

  IF (v_date_delta IS NULL OR v_date_delta <= 1)
    AND (
      (v_loc_sim   IS NOT NULL AND v_loc_sim   >= 0.65 AND v_name_sim >= 0.65)
      OR (v_board_dist IS NOT NULL AND v_board_dist <= 1000  AND v_name_sim >= 0.65)
      OR (v_loc_sim IS NULL AND v_board_dist IS NULL AND v_name_sim >= 0.90)
    )
  THEN
    v_result.match_id   := v_match_id;
    v_result.match_type := 'fuzzy';
    RETURN v_result;
  END IF;

  v_result.match_type := 'none';
  RETURN v_result;

END;
$$;