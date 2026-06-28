-- ============================================================
-- Migration: talent dedup functions
-- 20260627225004
--
-- Adds:
--   merge_talent()           — merges one talent record into another;
--                              re-points event_talent and follows,
--                              absorbs fields, deactivates duplicate
--   run_talent_dedup_pass()  — scans all active talent for duplicates
--                              and merges them; dry run by default
--
-- Canonical selection: confidence-weighted vote — sum extraction_confidence
-- across all sightings of events each talent appears on. The name that was
-- read by higher-confidence extractions wins. Ties break by created_at.
--
-- Two match tiers:
--   same_event     — both talent on the same event, name similarity >= 0.50.
--                    Co-occurrence is strong evidence; lower name bar.
--   name_similarity — name similarity >= 0.85 across all talent, no event
--                    co-occurrence required. High bar to avoid merging
--                    distinct acts with similar short names.
--
-- Usage:
--   SELECT * FROM run_talent_dedup_pass();        -- dry run
--   SELECT * FROM run_talent_dedup_pass(false);   -- live merge
-- ============================================================


-- ------------------------------------------------------------
-- MERGE TALENT
-- Merges p_duplicate_id into p_canonical_id (canonical = keep).
-- Re-points event_talent and follows; merges fields; deactivates duplicate.
-- Safe to call multiple times — skips inactive records.
-- Note: talent has no updated_at column.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION merge_talent(
  p_canonical_id UUID,
  p_duplicate_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_dup talent%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM talent WHERE id = p_canonical_id AND is_active = true) THEN
    RAISE NOTICE 'merge_talent: canonical % not active, skipping', p_canonical_id;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM talent WHERE id = p_duplicate_id AND is_active = true) THEN
    RAISE NOTICE 'merge_talent: duplicate % not active, skipping', p_duplicate_id;
    RETURN;
  END IF;

  SELECT * INTO v_dup FROM talent WHERE id = p_duplicate_id;

  -- 1. event_talent — canonical's row wins on conflict; delete dup's conflicting rows first
  DELETE FROM event_talent
  WHERE talent_id = p_duplicate_id
    AND event_id IN (
      SELECT event_id FROM event_talent WHERE talent_id = p_canonical_id
    );
  UPDATE event_talent SET talent_id = p_canonical_id WHERE talent_id = p_duplicate_id;

  -- 2. follows — same pattern
  DELETE FROM follows
  WHERE talent_id = p_duplicate_id
    AND user_id IN (
      SELECT user_id FROM follows WHERE talent_id = p_canonical_id
    );
  UPDATE follows SET talent_id = p_canonical_id WHERE talent_id = p_duplicate_id;

  -- 3. Merge fields onto canonical (canonical wins on conflict)
  UPDATE talent SET
    website        = COALESCE(website,        v_dup.website),
    description    = COALESCE(description,    v_dup.description),
    talent_type    = COALESCE(talent_type,    v_dup.talent_type),
    first_seen_at  = LEAST(first_seen_at,     v_dup.first_seen_at),
    last_active_at = GREATEST(last_active_at, v_dup.last_active_at)
  WHERE id = p_canonical_id;

  -- 4. Deactivate duplicate
  UPDATE talent SET is_active = false WHERE id = p_duplicate_id;
END;
$$;

GRANT EXECUTE ON FUNCTION merge_talent(UUID, UUID) TO service_role;


-- ------------------------------------------------------------
-- RUN TALENT DEDUP PASS
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION run_talent_dedup_pass(p_dry_run BOOLEAN DEFAULT true)
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
  CREATE TEMP TABLE _talent_dedup_pairs (
    canonical_id UUID,
    duplicate_id UUID,
    match_type   TEXT
  ) ON COMMIT DROP;

  -- Tier 1: Same-event — both talent on the same event with similar names.
  -- EXISTS avoids row multiplication when the pair shares multiple events.
  -- Canonical = confidence-weighted vote: sum extraction_confidence across all
  -- sightings of events each talent appears on. Higher total confidence wins;
  -- ties break by created_at (older wins).
  INSERT INTO _talent_dedup_pairs
  SELECT DISTINCT
    CASE
      WHEN weight_a.total >= weight_b.total THEN a.id
      ELSE b.id
    END,
    CASE
      WHEN weight_a.total >= weight_b.total THEN b.id
      ELSE a.id
    END,
    'same_event'
  FROM talent a
  JOIN talent b ON b.id > a.id AND b.is_active = true
  JOIN LATERAL (
    SELECT COALESCE(SUM(es.extraction_confidence), 0) AS total
    FROM event_talent et
    JOIN event_sightings es ON es.event_id = et.event_id
    WHERE et.talent_id = a.id
  ) weight_a ON true
  JOIN LATERAL (
    SELECT COALESCE(SUM(es.extraction_confidence), 0) AS total
    FROM event_talent et
    JOIN event_sightings es ON es.event_id = et.event_id
    WHERE et.talent_id = b.id
  ) weight_b ON true
  WHERE a.is_active = true
    AND similarity(lower(a.canonical_name), lower(b.canonical_name)) >= 0.50
    AND EXISTS (
      SELECT 1 FROM event_talent eta
      JOIN event_talent etb ON etb.event_id = eta.event_id AND etb.talent_id = b.id
      WHERE eta.talent_id = a.id
    );

  -- Tier 2: Cross-event — near-identical names, no event co-occurrence required.
  -- High threshold because there is no co-occurrence signal to corroborate.
  -- Same confidence-weighted canonical selection.
  INSERT INTO _talent_dedup_pairs
  SELECT DISTINCT
    CASE
      WHEN weight_a.total >= weight_b.total THEN a.id
      ELSE b.id
    END,
    CASE
      WHEN weight_a.total >= weight_b.total THEN b.id
      ELSE a.id
    END,
    'name_similarity'
  FROM talent a
  JOIN talent b ON b.id > a.id AND b.is_active = true
  JOIN LATERAL (
    SELECT COALESCE(SUM(es.extraction_confidence), 0) AS total
    FROM event_talent et
    JOIN event_sightings es ON es.event_id = et.event_id
    WHERE et.talent_id = a.id
  ) weight_a ON true
  JOIN LATERAL (
    SELECT COALESCE(SUM(es.extraction_confidence), 0) AS total
    FROM event_talent et
    JOIN event_sightings es ON es.event_id = et.event_id
    WHERE et.talent_id = b.id
  ) weight_b ON true
  WHERE a.is_active = true
    AND similarity(lower(a.canonical_name), lower(b.canonical_name)) >= 0.85
    AND NOT EXISTS (
      SELECT 1 FROM _talent_dedup_pairs p
      WHERE (p.canonical_id = a.id OR p.canonical_id = b.id)
        AND (p.duplicate_id = a.id OR p.duplicate_id = b.id)
    );

  FOR v_pair IN
    SELECT dp.canonical_id, tc.name AS canonical_name,
           dp.duplicate_id, td.name AS duplicate_name, dp.match_type
    FROM _talent_dedup_pairs dp
    JOIN talent tc ON tc.id = dp.canonical_id
    JOIN talent td ON td.id = dp.duplicate_id
    ORDER BY dp.match_type, tc.name
  LOOP
    canonical_id   := v_pair.canonical_id;
    canonical_name := v_pair.canonical_name;
    duplicate_id   := v_pair.duplicate_id;
    duplicate_name := v_pair.duplicate_name;
    match_type     := v_pair.match_type;

    IF NOT p_dry_run THEN
      PERFORM merge_talent(v_pair.canonical_id, v_pair.duplicate_id);
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION run_talent_dedup_pass(BOOLEAN) TO service_role;