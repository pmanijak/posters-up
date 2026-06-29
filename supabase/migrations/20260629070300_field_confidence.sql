-- Migration: find_event_match — per-field date confidence
-- When the extraction model reports low confidence on the date field
-- (p_date_confidence < 0.5), treat the date as unreliable rather than
-- using it as a hard filter. This prevents a misread digit (9→5, 19→11)
-- from spawning a duplicate event when name and location clearly match.
--
-- When date is untrusted:
--   - Date constraints are skipped in all tiers (treated as if date_start IS NULL)
--   - Name similarity thresholds are raised to compensate (0.65→0.80, 0.90→0.95)
--
-- p_date_confidence comes from field_confidence.date in raw_extraction,
-- populated by the extraction prompt's FIELD CONFIDENCE section.
-- Default NULL preserves existing behavior for callers not yet passing it.

CREATE OR REPLACE FUNCTION find_event_match(
  p_name              TEXT,
  p_date_start        DATE,
  p_location_name     TEXT,
  p_board_lat         FLOAT,
  p_board_lng         FLOAT,
  p_event_url         TEXT,
  p_talent_name       TEXT  DEFAULT NULL,
  p_date_confidence   FLOAT DEFAULT NULL  -- from field_confidence.date; null = trusted
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

  -- Tier 1.5: Talent anchor match
  -- When date is untrusted, skip the date constraint entirely.
  IF p_talent_name IS NOT NULL THEN
    SELECT e.id INTO v_match_id
    FROM events e
    JOIN event_talent et ON et.event_id  = e.id AND et.billing_position = 1
    JOIN talent t        ON t.id         = et.talent_id
    WHERE e.is_active = true
      AND similarity(lower(t.canonical_name), lower(p_talent_name)) >= 0.80
      AND (
        NOT v_date_trusted        -- date unreliable: skip date constraint
        OR p_date_start IS NULL
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
      NOT v_date_trusted        -- date unreliable: skip date filter entirely
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

  -- Final confidence check.
  -- When date is untrusted, skip the date delta gate and require
  -- stronger name similarity to compensate for the missing anchor.
  IF (v_date_delta IS NULL OR (v_date_trusted AND v_date_delta <= 1) OR NOT v_date_trusted)
    AND (
      (v_loc_sim IS NOT NULL AND v_loc_sim >= 0.65
        AND v_name_sim >= CASE WHEN v_date_trusted THEN 0.65 ELSE 0.80 END)
      OR (v_board_dist IS NOT NULL AND v_board_dist <= 1000
        AND v_name_sim >= CASE WHEN v_date_trusted THEN 0.65 ELSE 0.80 END)
      OR (v_loc_sim IS NULL AND v_board_dist IS NULL
        AND v_name_sim >= CASE WHEN v_date_trusted THEN 0.90 ELSE 0.95 END)
      -- One location name is a substring of the other.
      -- Catches "ORCA" vs "ORCA Books", "Obsidian" vs "Obsidian Bar & Lounge", etc.
      OR (p_location_name IS NOT NULL AND v_match_location IS NOT NULL
        AND v_name_sim >= CASE WHEN v_date_trusted THEN 0.65 ELSE 0.80 END
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