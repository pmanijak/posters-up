-- Migration: add same-board proximity check to run_dedup_pass fuzzy tier
-- Catches partial location_name extractions ("ORCA" vs "ORCA Books") that
-- fail string similarity but are provably co-located via shared board_id.

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
  --   2. name similarity >= 0.90 when location is absent on either side
  --   3. shared board_id — catches partial extractions ("ORCA" vs "ORCA Books")
  --      that fail string similarity but are provably co-located
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
      EXISTS (
        SELECT 1
        FROM event_sightings esa
        JOIN event_sightings esb ON esb.board_id = esa.board_id
        WHERE esa.event_id = a.id
          AND esb.event_id = b.id
          AND esa.board_id IS NOT NULL
      )
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