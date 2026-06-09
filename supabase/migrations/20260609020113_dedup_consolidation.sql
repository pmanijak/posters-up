-- ============================================================
-- Deduplication Migration
-- Version 8 — event matching support
--
-- Applies on top of schema_v7.sql.
--
-- Philosophy: a matching event on a new board is an additional
-- sighting, not a duplicate to clean up. The extract function
-- either links a new sighting to an existing event (confidence
-- goes up naturally via compute_event_confidence) or creates a
-- new event if no match is found. No staging table, no merge
-- step, no cleanup job.
--
-- What this adds:
--   - pg_trgm extension + functional GIN index on event names
--   - normalize_event_name()   consistent name normalization
--   - find_event_match()       called at extraction time
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Functional GIN index on normalized event names.
-- Enables the '%' (similarity threshold) operator in find_event_match()
-- to use the index rather than a sequential scan.
-- normalize_event_name() must be IMMUTABLE for this to work.
CREATE INDEX IF NOT EXISTS idx_events_name_trgm
  ON events USING GIN (lower(name) gin_trgm_ops);


-- ============================================================
-- NORMALIZE EVENT NAME
-- Strips punctuation and filler words, lowercases, collapses
-- whitespace. IMMUTABLE so it can be used in functional indexes.
-- ============================================================
CREATE OR REPLACE FUNCTION normalize_event_name(p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT
AS $$
DECLARE
  result TEXT;
BEGIN
  result := lower(p_name);
  result := regexp_replace(result, '[^a-z0-9 ]', '', 'g');
  result := regexp_replace(result,
    '\y(the|a|an|and|presents|feat|featuring|with|at|in|on)\y', '', 'g');
  result := regexp_replace(result, '\s+', ' ', 'g');
  RETURN trim(result);
END;
$$;


-- ============================================================
-- FIND EVENT MATCH
-- Called by the extract Edge Function for each extracted event
-- before deciding whether to create a new events row.
--
-- Returns (match_id UUID, match_type TEXT):
--
--   'url'   — event_url matches an existing active event exactly.
--             Link the new sighting to this event.
--
--   'fuzzy' — name + date + location match with high confidence.
--             Link the new sighting to this event.
--             Threshold is intentionally strict: a false match
--             inflates an existing event's confidence, which is
--             worse than having two listings for a while.
--
--   'none'  — no confident match found. Create a new event.
--
-- Board lat/lng is used as a geo proxy at extraction time because
-- events don't have their own location_geo until web enrichment
-- runs. It stands in for "are these events being posted in the
-- same area?"
-- ============================================================

DO $$ BEGIN
  CREATE TYPE event_match_result AS (match_id UUID, match_type TEXT);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION find_event_match(
  p_name          TEXT,
  p_date_start    DATE,
  p_location_name TEXT,
  p_board_lat     FLOAT,
  p_board_lng     FLOAT,
  p_event_url     TEXT
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

  -- -------------------------------------------------------
  -- Tier 1: URL hard match
  -- Same event_url = same event, no ambiguity.
  -- -------------------------------------------------------
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

  -- -------------------------------------------------------
  -- Tier 2: Fuzzy match — name + date + location
  -- All three signals must be present and agree for an
  -- auto-match. If any signal is absent or disagrees, return
  -- 'none' and let the caller create a new event.
  --
  -- Thresholds are strict because a wrong match is worse than
  -- a duplicate: it inflates confidence on the wrong record.
  -- -------------------------------------------------------
  v_norm_name := normalize_event_name(p_name);

  IF p_board_lat IS NOT NULL AND p_board_lng IS NOT NULL THEN
    v_board_geo := ST_SetSRID(ST_MakePoint(p_board_lng, p_board_lat), 4326)::geography;
  END IF;

  PERFORM set_config('pg_trgm.similarity_threshold', '0.70', true);

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
    AND lower(e.name) % v_norm_name           -- uses GIN index
    AND (
      p_date_start IS NULL
      OR e.date_start IS NULL
      OR ABS(e.date_start - p_date_start) <= 2
    )
  GROUP BY e.id
  ORDER BY similarity(normalize_event_name(e.name), v_norm_name) DESC
  LIMIT 1;

  -- No name+date match at all → new event
  IF v_match_id IS NULL THEN
    v_result.match_type := 'none';
    RETURN v_result;
  END IF;

  -- High-confidence: name ≥ 0.80 AND date within 1 day AND
  -- at least one location signal confirms it.
  -- If location signals are both absent, require name ≥ 0.90
  -- (stronger name alone can stand in when location is unknown).
  IF v_name_sim >= 0.80
    AND (v_date_delta IS NULL OR v_date_delta <= 1)
    AND (
      (v_loc_sim   IS NOT NULL AND v_loc_sim   >= 0.65)
      OR (v_board_dist IS NOT NULL AND v_board_dist <= 1000)
      OR (v_loc_sim IS NULL AND v_board_dist IS NULL AND v_name_sim >= 0.90)
    )
  THEN
    v_result.match_id   := v_match_id;
    v_result.match_type := 'fuzzy';
    RETURN v_result;
  END IF;

  -- Didn't meet the threshold → new event
  v_result.match_type := 'none';
  RETURN v_result;

END;
$$;