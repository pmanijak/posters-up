-- Migration: add location name substring check to event matching
-- Catches partial location extractions ("ORCA" vs "ORCA Books",
-- "Obsidian" vs "Obsidian Bar & Lounge") that fail trigram similarity
-- but are clearly the same venue.
-- Applied to both find_event_match (insertion-time) and run_dedup_pass
-- (nightly pass) for consistency.

-- ── find_event_match ──────────────────────────────────────────────────────────
-- Changes:
--   DECLARE: added v_match_location TEXT
--   SELECT:  added e.location_name
--   INTO:    added v_match_location
--   validation block: added substring path to location condition

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
      WHEN p_location_name IS NOT NULL AND e.location_name IS NOT NULL
      THEN similarity(lower(e.location_name), lower(p_location_name))
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
      -- One location name is a substring of the other.
      -- Catches "ORCA" vs "ORCA Books", "Obsidian" vs "Obsidian Bar & Lounge", etc.
      OR (v_name_sim >= 0.65
          AND p_location_name IS NOT NULL AND v_match_location IS NOT NULL
          AND (
            lower(p_location_name) LIKE '%' || lower(v_match_location) || '%'
            OR lower(v_match_location) LIKE '%' || lower(p_location_name) || '%'
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


-- ── run_dedup_pass ────────────────────────────────────────────────────────────
-- Change: added substring path to fuzzy tier location condition

CREATE OR REPLACE FUNCTION run_dedup_pass(p_dry_run BOOLEAN DEFAULT true)
RETURNS TABLE (
  canonical_id   UUID,
  canonical_name TEXT,
  duplicate_id   UUID,
  duplicate_name TEXT,
  match_type     TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_pair RECORD;
BEGIN
  CREATE TEMP TABLE _dedup_pairs (
    canonical_id UUID,
    duplicate_id UUID,
    match_type   TEXT
  ) ON COMMIT DROP;

  -- Tier 1: URL hard match
  INSERT INTO _dedup_pairs
  SELECT
    CASE WHEN a.created_at <= b.created_at THEN a.id ELSE b.id END,
    CASE WHEN a.created_at <= b.created_at THEN b.id ELSE a.id END,
    'url'
  FROM events a
  JOIN events b ON b.event_url = a.event_url AND b.id > a.id AND b.is_active = true
  WHERE a.is_active = true AND a.event_url IS NOT NULL;

  -- Tier 1.5: Talent anchor match
  INSERT INTO _dedup_pairs
  SELECT
    CASE WHEN a.created_at <= b.created_at THEN a.id ELSE b.id END,
    CASE WHEN a.created_at <= b.created_at THEN b.id ELSE a.id END,
    'talent_anchor'
  FROM events a
  JOIN events b ON b.id > a.id AND b.is_active = true
  JOIN LATERAL (
    SELECT t.canonical_name FROM event_talent et JOIN talent t ON t.id = et.talent_id
    WHERE et.event_id = a.id ORDER BY et.billing_position ASC NULLS LAST LIMIT 1
  ) ta ON true
  JOIN LATERAL (
    SELECT t.canonical_name FROM event_talent et JOIN talent t ON t.id = et.talent_id
    WHERE et.event_id = b.id ORDER BY et.billing_position ASC NULLS LAST LIMIT 1
  ) tb ON true
  WHERE a.is_active = true
    AND similarity(lower(ta.canonical_name), lower(tb.canonical_name)) >= 0.80
    AND (a.date_start IS NULL OR b.date_start IS NULL OR ABS(a.date_start - b.date_start) <= 1)
    AND (a.location_name IS NULL OR b.location_name IS NULL
         OR similarity(lower(a.location_name), lower(b.location_name)) >= 0.60)
    AND NOT EXISTS (
      SELECT 1 FROM _dedup_pairs p
      WHERE (p.canonical_id = a.id OR p.canonical_id = b.id)
        AND (p.duplicate_id = a.id OR p.duplicate_id = b.id)
    );

  -- Tier 2: Fuzzy name match
  -- Location condition has three paths (any one sufficient):
  --   1. location_name string similarity >= 0.65 (standard case)
  --   2. name similarity >= 0.90 when location_name absent on either side
  --   3. one location name is a substring of the other — catches partial
  --      extractions ("ORCA" vs "ORCA Books", "Obsidian" vs "Obsidian Bar & Lounge")
  --      that fail string similarity but are clearly the same place
  INSERT INTO _dedup_pairs
  SELECT
    CASE WHEN a.created_at <= b.created_at THEN a.id ELSE b.id END,
    CASE WHEN a.created_at <= b.created_at THEN b.id ELSE a.id END,
    'fuzzy'
  FROM events a
  JOIN events b ON b.id > a.id AND b.is_active = true
  WHERE a.is_active = true
    AND similarity(normalize_event_name(a.name), normalize_event_name(b.name)) >= 0.65
    AND (a.date_start IS NULL OR b.date_start IS NULL OR ABS(a.date_start - b.date_start) <= 1)
    AND (
      (a.location_name IS NOT NULL AND b.location_name IS NOT NULL
       AND similarity(lower(a.location_name), lower(b.location_name)) >= 0.65)
      OR
      ((a.location_name IS NULL OR b.location_name IS NULL)
       AND similarity(normalize_event_name(a.name), normalize_event_name(b.name)) >= 0.90)
      OR
      (a.location_name IS NOT NULL AND b.location_name IS NOT NULL
       AND (
         lower(a.location_name) LIKE '%' || lower(b.location_name) || '%'
         OR lower(b.location_name) LIKE '%' || lower(a.location_name) || '%'
       ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM _dedup_pairs p
      WHERE (p.canonical_id = a.id OR p.canonical_id = b.id)
        AND (p.duplicate_id = a.id OR p.duplicate_id = b.id)
    );

  FOR v_pair IN
    SELECT dp.canonical_id, ec.name AS canonical_name,
           dp.duplicate_id, ed.name AS duplicate_name, dp.match_type
    FROM _dedup_pairs dp
    JOIN events ec ON ec.id = dp.canonical_id
    JOIN events ed ON ed.id = dp.duplicate_id
    ORDER BY dp.match_type, ec.name
  LOOP
    canonical_id   := v_pair.canonical_id;
    canonical_name := v_pair.canonical_name;
    duplicate_id   := v_pair.duplicate_id;
    duplicate_name := v_pair.duplicate_name;
    match_type     := v_pair.match_type;

    IF NOT p_dry_run THEN
      PERFORM merge_events(v_pair.canonical_id, v_pair.duplicate_id);
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$$;