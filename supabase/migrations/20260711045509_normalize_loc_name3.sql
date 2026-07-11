-- ============================================================
-- Migration: normalize_location_name() for dedup location comparisons
--
-- Root cause: location_name comparisons across find_event_match() and
-- run_dedup_pass() use raw similarity(lower(a), lower(b)) with no
-- punctuation normalization -- unlike event names, which already go
-- through normalize_event_name(). Possessive apostrophes silently
-- depress trigram similarity and break the existing substring
-- fallback ("mccoys" is not a substring of "mccoy's tavern" because
-- the apostrophe interrupts the character run), so semantically
-- identical venue names can fail every location check.
--
-- Concrete case: "McCoy's Tavern" vs "McCoys" scored 0.294 similarity
-- (floor is 0.60 for talent_anchor), and the substring fallback also
-- failed for the same reason -- leaving a real duplicate ("Baby & The
-- Nobodies / Buck Male / Bassafras" vs "...Dick Rossetti / Bulk Male
-- / Bassafras") stranded as two separate events despite sharing the
-- same billing_position=1 talent and the same date.
--
-- Fix: add normalize_location_name(), mirroring normalize_event_name(),
-- and apply it everywhere location_name is compared in the live-path
-- matching function:
--   - find_event_match() 7-arg overload: talent_anchor, location_anchor,
--     fuzzy tier (similarity computation + substring fallback)
--   - find_event_match() 8-arg overload: same four sites
--
-- run_dedup_pass() is intentionally NOT touched here -- see the note
-- above its old location further down, and migration_dedup_date_type_
-- mismatch.sql, which fully supersedes it.
--
-- Thresholds (0.60 / 0.85 / 0.65) are left unchanged -- this migration
-- only normalizes the inputs being compared, not the bar for matching.
-- ============================================================

-- ------------------------------------------------------------
-- NORMALIZE LOCATION NAME
-- Strips possessive apostrophes and punctuation, lowercases, collapses
-- whitespace. Mirrors normalize_event_name() so the two normalization
-- passes read consistently. Does NOT strip generic venue-type words
-- ("Tavern", "Records", "Books") -- those can be load-bearing for
-- distinguishing venues and stripping them risks false merges; the
-- existing substring fallback already covers "ORCA" vs "ORCA Books"
-- once punctuation is out of the way.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION normalize_location_name(p_location TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  result TEXT;
BEGIN
  IF p_location IS NULL THEN
    RETURN NULL;
  END IF;

  result := lower(p_location);

  -- Strip apostrophes (straight and curly) entirely rather than
  -- replacing with a space -- "mccoy's" should become "mccoys",
  -- not "mccoy s".
  result := regexp_replace(result, '[''’]', '', 'g');

  -- Remaining punctuation becomes a space, so "Rainy Day, Records"
  -- and "Rainy Day Records" normalize the same way.
  result := regexp_replace(result, '[^a-z0-9 ]', ' ', 'g');

  result := regexp_replace(result, '\s+', ' ', 'g');
  RETURN trim(result);
END;
$$;

-- Functional GIN index for trigram lookups on the normalized form,
-- mirroring idx_events_name_normalized_trgm.
CREATE INDEX IF NOT EXISTS idx_events_location_normalized_trgm
  ON events USING GIN (normalize_location_name(location_name) gin_trgm_ops);


-- ------------------------------------------------------------
-- FIND EVENT MATCH (7-arg overload)
-- Unchanged except: every location_name comparison now runs through
-- normalize_location_name() on both sides.
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
  v_result          event_match_result;
  v_norm_name       TEXT;
  v_norm_location   TEXT;
  v_board_geo       GEOGRAPHY;
  v_match_id        UUID;
  v_name_sim        FLOAT;
  v_date_delta      INT;
  v_loc_sim         FLOAT;
  v_board_dist      FLOAT;
  v_match_location  TEXT;
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

  v_norm_location := normalize_location_name(p_location_name);

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
        v_norm_location IS NULL
        OR e.location_name IS NULL
        OR similarity(normalize_location_name(e.location_name), v_norm_location) >= 0.60
        OR normalize_location_name(e.location_name) LIKE '%' || v_norm_location || '%'
        OR v_norm_location LIKE '%' || normalize_location_name(e.location_name) || '%'
      )
    ORDER BY similarity(lower(t.canonical_name), lower(p_talent_name)) DESC
    LIMIT 1;

    IF v_match_id IS NOT NULL THEN
      v_result.match_id   := v_match_id;
      v_result.match_type := 'talent_anchor';
      RETURN v_result;
    END IF;
  END IF;

  -- Tier 1.7: Location anchor — same exact date + high location similarity.
  -- Fires when name similarity is too low for the fuzzy tier (OCR failures,
  -- wildly different poster readings of the same event). The 0.20 name
  -- floor prevents two genuinely different events at the same venue on
  -- the same day from merging. Requires both date and location known.
  IF p_date_start IS NOT NULL AND v_norm_location IS NOT NULL THEN
    SELECT e.id INTO v_match_id
    FROM events e
    WHERE e.is_active = true
      AND e.date_start = p_date_start
      AND e.location_name IS NOT NULL
      AND (
        similarity(normalize_location_name(e.location_name), v_norm_location) >= 0.85
        OR normalize_location_name(e.location_name) LIKE '%' || v_norm_location || '%'
        OR v_norm_location LIKE '%' || normalize_location_name(e.location_name) || '%'
      )
      AND similarity(normalize_event_name(e.name), normalize_event_name(p_name)) >= 0.20
    ORDER BY similarity(normalize_location_name(e.location_name), v_norm_location) DESC
    LIMIT 1;

    IF v_match_id IS NOT NULL THEN
      v_result.match_id   := v_match_id;
      v_result.match_type := 'location_anchor';
      RETURN v_result;
    END IF;
  END IF;

  -- Tier 2: Fuzzy match — name + date + location
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
      WHEN v_norm_location IS NOT NULL AND e.location_name IS NOT NULL
      THEN similarity(normalize_location_name(e.location_name), v_norm_location)
      ELSE NULL
    END,
    CASE
      WHEN v_board_geo IS NOT NULL
      THEN MIN(ST_Distance(b.geolocation::geography, v_board_geo))
      ELSE NULL
    END,
    e.location_name
  INTO v_match_id, v_name_sim, v_date_delta, v_loc_sim, v_board_dist, v_match_location
  FROM events e
  LEFT JOIN event_sightings es ON es.event_id = e.id
  LEFT JOIN boards b           ON b.id = es.board_id AND b.geolocation IS NOT NULL
  WHERE e.is_active = true
    -- normalize_event_name() applied to both sides so the % operator compares
    -- apples to apples. Previously compared raw lower(e.name) against the
    -- already-normalized v_norm_name, causing low similarity scores that
    -- filtered out valid candidates (e.g. "No Hate!" vs "No Hate").
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
      -- One location name is a substring of the other, compared on
      -- normalized forms so punctuation (e.g. possessive apostrophes)
      -- doesn't break the match. Catches "ORCA" vs "ORCA Books",
      -- "Obsidian" vs "Obsidian Bar & Lounge", "McCoys" vs
      -- "McCoy's Tavern", etc.
      OR (v_name_sim >= 0.65
          AND v_norm_location IS NOT NULL AND v_match_location IS NOT NULL
          AND (
            v_norm_location LIKE '%' || normalize_location_name(v_match_location) || '%'
            OR normalize_location_name(v_match_location) LIKE '%' || v_norm_location || '%'
          ))
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


-- ------------------------------------------------------------
-- FIND EVENT MATCH (8-arg, date-confidence-aware overload)
-- Same normalization treatment as the 7-arg version above.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION find_event_match(
  p_name             TEXT,
  p_date_start       DATE,
  p_location_name    TEXT,
  p_board_lat        FLOAT,
  p_board_lng        FLOAT,
  p_event_url        TEXT,
  p_talent_name      TEXT DEFAULT NULL,
  p_date_confidence  FLOAT DEFAULT NULL
)
RETURNS event_match_result
LANGUAGE plpgsql
AS $$
DECLARE
  v_result          event_match_result;
  v_norm_name       TEXT;
  v_norm_location   TEXT;
  v_board_geo       GEOGRAPHY;
  v_match_id        UUID;
  v_name_sim        FLOAT;
  v_date_delta      INT;
  v_loc_sim         FLOAT;
  v_board_dist      FLOAT;
  v_match_location  TEXT;
  v_date_trusted    BOOLEAN;  -- false = skip date constraints, raise name sim bar
BEGIN
  -- A date confidence below 0.5 means the model was sufficiently uncertain
  -- about specific digits that the date cannot anchor a dedup decision.
  -- NULL means the caller didn't supply a confidence (legacy callers, or
  -- flyers where the date field wasn't scored) — treat as trusted.
  v_date_trusted := (p_date_confidence IS NULL OR p_date_confidence >= 0.5);

  -- Tier 1: URL hard match — date irrelevant
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

  v_norm_location := normalize_location_name(p_location_name);

  -- Tier 1.5: Talent anchor match — date constraint skipped when untrusted
  IF p_talent_name IS NOT NULL THEN
    SELECT e.id INTO v_match_id
    FROM events e
    JOIN event_talent et ON et.event_id  = e.id AND et.billing_position = 1
    JOIN talent t        ON t.id         = et.talent_id
    WHERE e.is_active = true
      AND similarity(lower(t.canonical_name), lower(p_talent_name)) >= 0.80
      AND (
        NOT v_date_trusted
        OR p_date_start IS NULL
        OR e.date_start IS NULL
        OR ABS(e.date_start - p_date_start) <= 1
      )
      AND (
        v_norm_location IS NULL
        OR e.location_name IS NULL
        OR similarity(normalize_location_name(e.location_name), v_norm_location) >= 0.60
        OR normalize_location_name(e.location_name) LIKE '%' || v_norm_location || '%'
        OR v_norm_location LIKE '%' || normalize_location_name(e.location_name) || '%'
      )
    ORDER BY similarity(lower(t.canonical_name), lower(p_talent_name)) DESC
    LIMIT 1;

    IF v_match_id IS NOT NULL THEN
      v_result.match_id   := v_match_id;
      v_result.match_type := 'talent_anchor';
      RETURN v_result;
    END IF;
  END IF;

  -- Tier 1.7: Location anchor — skipped entirely when date is untrusted,
  -- since the exact date match IS the anchor here; relaxing it would
  -- leave only location, too broad a signal on its own.
  IF v_date_trusted AND p_date_start IS NOT NULL AND v_norm_location IS NOT NULL THEN
    SELECT e.id INTO v_match_id
    FROM events e
    WHERE e.is_active = true
      AND e.date_start = p_date_start
      AND e.location_name IS NOT NULL
      AND (
        similarity(normalize_location_name(e.location_name), v_norm_location) >= 0.85
        OR normalize_location_name(e.location_name) LIKE '%' || v_norm_location || '%'
        OR v_norm_location LIKE '%' || normalize_location_name(e.location_name) || '%'
      )
      AND similarity(normalize_event_name(e.name), normalize_event_name(p_name)) >= 0.20
    ORDER BY similarity(normalize_location_name(e.location_name), v_norm_location) DESC
    LIMIT 1;

    IF v_match_id IS NOT NULL THEN
      v_result.match_id   := v_match_id;
      v_result.match_type := 'location_anchor';
      RETURN v_result;
    END IF;
  END IF;

  -- Tier 2: Fuzzy match — name + date + location
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
      WHEN v_norm_location IS NOT NULL AND e.location_name IS NOT NULL
      THEN similarity(normalize_location_name(e.location_name), v_norm_location)
      ELSE NULL
    END,
    CASE
      WHEN v_board_geo IS NOT NULL
      THEN MIN(ST_Distance(b.geolocation::geography, v_board_geo))
      ELSE NULL
    END,
    e.location_name
  INTO v_match_id, v_name_sim, v_date_delta, v_loc_sim, v_board_dist, v_match_location
  FROM events e
  LEFT JOIN event_sightings es ON es.event_id = e.id
  LEFT JOIN boards b           ON b.id = es.board_id AND b.geolocation IS NOT NULL
  WHERE e.is_active = true
    AND normalize_event_name(e.name) % v_norm_name
    AND (
      NOT v_date_trusted
      OR p_date_start IS NULL
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

  -- Final confidence check. When date is untrusted, skip the date-delta
  -- gate and require stronger name similarity to compensate.
  IF (v_date_delta IS NULL OR (v_date_trusted AND v_date_delta <= 1) OR NOT v_date_trusted)
    AND (
      (v_loc_sim IS NOT NULL AND v_loc_sim >= 0.65
        AND v_name_sim >= CASE WHEN v_date_trusted THEN 0.65 ELSE 0.80 END)
      OR (v_board_dist IS NOT NULL AND v_board_dist <= 1000
        AND v_name_sim >= CASE WHEN v_date_trusted THEN 0.65 ELSE 0.80 END)
      OR (v_loc_sim IS NULL AND v_board_dist IS NULL
        AND v_name_sim >= CASE WHEN v_date_trusted THEN 0.90 ELSE 0.95 END)
      OR (v_norm_location IS NOT NULL AND v_match_location IS NOT NULL
        AND v_name_sim >= CASE WHEN v_date_trusted THEN 0.65 ELSE 0.80 END
        AND (
          v_norm_location LIKE '%' || normalize_location_name(v_match_location) || '%'
          OR normalize_location_name(v_match_location) LIKE '%' || v_norm_location || '%'
        ))
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


-- run_dedup_pass() is deliberately NOT redefined in this migration.
-- The follow-up migration (migration_dedup_date_type_mismatch.sql) fully
-- supersedes it anyway (same normalize_location_name() calls, plus
-- date_type_mismatch on top), and CREATE OR REPLACE can't change a
-- RETURNS TABLE column list -- redefining it here with the old 5-column
-- shape would conflict with a 6-column version already deployed by the
-- follow-up migration if these are re-run out of order. Leaving it
-- untouched here means this file is safe to re-run at any point
-- regardless of whether the follow-up migration has already landed.

-- ------------------------------------------------------------
-- GRANTS
-- normalize_location_name() is a brand new function, so it falls
-- outside schema_current.sql's one-time "GRANT ALL ON ALL FUNCTIONS
-- IN SCHEMA public TO service_role" bulk statement (not ALTER DEFAULT
-- PRIVILEGES -- it only covered functions that existed when it ran).
-- Postgres's actual default for a new function is EXECUTE granted to
-- PUBLIC, which nothing here overrides otherwise, so this pins it to
-- the same explicit state as the rest of the schema instead of
-- depending on Supabase's platform-level provisioning.
--
-- find_event_match() (both overloads) and run_dedup_pass() are
-- CREATE OR REPLACE of existing objects here, so they keep their
-- current grants as-is and need no action in this migration.
-- run_dedup_pass() does get re-granted in the follow-up date_type_
-- mismatch migration, but that's for an unrelated reason (it gets
-- DROPped there because its RETURNS TABLE column list changes).
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION normalize_location_name(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION normalize_location_name(TEXT) TO service_role;