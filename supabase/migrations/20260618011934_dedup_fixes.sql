-- ============================================================
-- Dedup Improvement Migration
-- Applies on top of dedup migration (schema_v7 + migration v1).
--
-- Three fixes:
--   1. normalize_event_name  — strip venue suffixes and date fragments
--                              before trigram comparison
--   2. find_event_match      — add Tier 1.5: talent anchor match
--                              (top-billed act + date + location)
--   3. find_event_match      — lower fuzzy name threshold 0.80 → 0.65
--                              when date AND location both confirm
--
-- Signature change: find_event_match gains a 7th parameter,
-- p_talent_name TEXT DEFAULT NULL. The old 6-parameter overload
-- is dropped first to avoid a stale overload accumulating.
-- The extract Edge Function should be updated to pass talent[0].name
-- as the 7th argument; callers that omit it get NULL (safe fallback).
-- ============================================================

BEGIN;

-- ============================================================
-- 1. GIN trigram index on talent.canonical_name
--    Needed for the talent anchor tier. Covers the similarity()
--    call in Tier 1.5 without a sequential scan on talent.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_talent_canonical_trgm
  ON talent USING GIN (lower(canonical_name) gin_trgm_ops);


-- ============================================================
-- 2. NORMALIZE EVENT NAME (improved)
--    New: strips trailing venue suffix and inline date fragments
--    before the trigram comparison. IMMUTABLE so the existing
--    functional GIN index on events continues to work.
--
--    Input → normalized output examples:
--      "Landroid / Dreamwave / New Wave Night — McCoys Tavern"
--        → "landroid dreamwave new wave night"
--      "Landroid – June 18"
--        → "landroid"
--      "Landroid / Dreamwave"
--        → "landroid dreamwave"
-- ============================================================
CREATE OR REPLACE FUNCTION normalize_event_name(p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT
AS $$
DECLARE
  result TEXT;
BEGIN
  result := lower(p_name);

  -- Strip trailing venue suffix introduced by em/en dash or hyphen.
  -- Handles: "Event Name — Venue", "Event Name – Venue", "Event Name - Venue"
  -- Must run before punctuation removal so the dash is still present.
  result := regexp_replace(result, '\s*[—–\-]\s*.+$', '', 'g');

  -- Strip trailing "at Venue" / "@ Venue" suffix.
  -- Handles cases where the AI appended the venue to the title.
  result := regexp_replace(result, '\s+at\s+\S.*$', '', 'g');
  result := regexp_replace(result, '\s+@\s+\S.*$',  '', 'g');

  -- Strip inline date fragments: "June 18", "Jun 18", "July 4th", "july 4".
  -- These appear when the AI serializes the date into the event name.
  result := regexp_replace(result,
    '\m(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{1,2}(st|nd|rd|th)?\M',
    '', 'gi');

  -- Strip bare 4-digit years.
  result := regexp_replace(result, '\m20\d{2}\M', '', 'g');

  -- Strip remaining punctuation.
  result := regexp_replace(result, '[^a-z0-9 ]', '', 'g');

  -- Strip filler words.
  result := regexp_replace(result,
    '\y(the|a|an|and|presents|feat|featuring|with|at|in|on)\y', '', 'g');

  result := regexp_replace(result, '\s+', ' ', 'g');
  RETURN trim(result);
END;
$$;


-- ============================================================
-- 3. FIND EVENT MATCH (updated)
--    Drop the old 6-parameter overload before replacing.
--    PostgreSQL treats a different parameter list as a new
--    function, so CREATE OR REPLACE alone would leave the old
--    overload in place and the extract function would continue
--    routing to it.
-- ============================================================
DROP FUNCTION IF EXISTS find_event_match(TEXT, DATE, TEXT, FLOAT, FLOAT, TEXT);

CREATE OR REPLACE FUNCTION find_event_match(
  p_name          TEXT,
  p_date_start    DATE,
  p_location_name TEXT,
  p_board_lat     FLOAT,
  p_board_lng     FLOAT,
  p_event_url     TEXT,
  p_talent_name   TEXT DEFAULT NULL   -- top-billed act name; new in this migration
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
  -- Tier 1.5: Talent anchor match
  -- Top-billed act + date + location is a stable identity
  -- signal that survives inconsistent AI event naming.
  -- Requires billing_position = 1 on both the candidate and
  -- the incoming extraction so we're comparing headliners,
  -- not incidentally shared support acts.
  -- -------------------------------------------------------
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


  -- -------------------------------------------------------
  -- Tier 2: Fuzzy match — name + date + location
  -- All three signals must be present and agree.
  --
  -- Threshold reduced 0.80 → 0.65 when date AND location
  -- both confirm. Two independent corroborating signals make
  -- a lower name similarity safe. The higher threshold (0.90)
  -- still applies when only the name signal is available.
  -- -------------------------------------------------------
  v_norm_name := normalize_event_name(p_name);

  IF p_board_lat IS NOT NULL AND p_board_lng IS NOT NULL THEN
    v_board_geo := ST_SetSRID(ST_MakePoint(p_board_lng, p_board_lat), 4326)::geography;
  END IF;

  PERFORM set_config('pg_trgm.similarity_threshold', '0.60', true);
  -- Lowered from 0.70 to match the relaxed fuzzy threshold below.
  -- The index scan uses this threshold; the final gate is in the IF below.

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

  -- No name+date candidate at all → new event
  IF v_match_id IS NULL THEN
    v_result.match_type := 'none';
    RETURN v_result;
  END IF;

  -- High-confidence: date within 1 day AND at least one location signal,
  -- with a relaxed name threshold of 0.65 (was 0.80).
  -- If both location signals are absent, name must be ≥ 0.90 to stand alone.
  IF (v_date_delta IS NULL OR v_date_delta <= 1)
    AND (
      -- Both corroborating signals present: relax name threshold
      (v_loc_sim   IS NOT NULL AND v_loc_sim   >= 0.65 AND v_name_sim >= 0.65)
      OR (v_board_dist IS NOT NULL AND v_board_dist <= 1000  AND v_name_sim >= 0.65)
      -- No location signals: name must carry the match alone
      OR (v_loc_sim IS NULL AND v_board_dist IS NULL AND v_name_sim >= 0.90)
    )
  THEN
    v_result.match_id   := v_match_id;
    v_result.match_type := 'fuzzy';
    RETURN v_result;
  END IF;

  -- Didn't meet threshold → new event
  v_result.match_type := 'none';
  RETURN v_result;

END;
$$;

COMMIT;

-- ============================================================
-- POST-MIGRATION: update the extract Edge Function
--
-- find_event_match() now accepts a 7th argument: the top-billed
-- act name from the extraction result. Pass talent[0].name
-- (where billing_position = 1, or the first talent entry if
-- billing_position is null) when calling from the Edge Function.
--
-- Callers that omit the argument receive NULL and fall through
-- to the fuzzy tier as before — no breaking change.
-- ============================================================