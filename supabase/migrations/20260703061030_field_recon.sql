-- ============================================================
-- MIGRATION: run_field_reconciliation_pass()
-- ============================================================
--
-- Problem: events.name, date_start, and location_name are set once at
-- event creation (in the extract Edge Function) and never revised by
-- the "existing event" merge branch — that branch only updates
-- event_category, age_restriction, language, masks_required, price_raw,
-- event_url, flyer_style, and the boolean fields. If the founding
-- sighting misread the name ("Ton Rauson"), every later, clearer
-- sighting of the same event is powerless to fix it.
--
-- Fix: a periodic pass, same shape as run_dedup_pass() and
-- run_talent_dedup_pass(), that takes a confidence-weighted plurality
-- vote across all non-rejected sightings' raw_extraction for each of
-- the three contested fields, and updates the event when the vote
-- winner differs from what's currently stored.
--
-- Non-destructive: raw_extraction is preserved forever on
-- event_sightings, so this can be re-run any time the extraction
-- prompt, config, or vote logic improves — nothing is lost by getting
-- an early run wrong.
--
-- Voting mechanism:
--   1. Unpivot name/date_start/location_name from raw_extraction into
--      one row per (event, field, value, confidence). Confidence comes
--      from raw_extraction->field_confidence when present (name, date,
--      location all have per-field scores), falling back to the
--      sighting's overall extraction_confidence otherwise.
--   2. Group by trim(lower(value)) to absorb whitespace/casing noise
--      without merging genuinely different OCR misreads into the same
--      bucket — "Tom Rawson" and "Ton Rauson" stay separate buckets on
--      purpose. Fuzzy-clustering near-miss variants (the way talent
--      dedup does with pg_trgm) is a harder problem and left for a
--      future pass if this one proves insufficient in practice.
--   3. Within each bucket, keep the highest-confidence original-cased
--      reading as the display value — the vote decides *which* reading
--      wins, but the winning reading's own casing/formatting is used
--      verbatim, not a lowest-common-denominator of the bucket.
--   4. Sum confidence per bucket; the bucket with the highest total
--      weight wins. Only surfaced when the winner differs from the
--      value currently stored on the event.
--
-- Naming note: every RETURNS TABLE column below is implicitly a
-- PL/pgSQL variable inside this function body (event_id, field,
-- old_value, new_value, ...). Every SQL reference to a same-named
-- table/CTE column is therefore explicitly alias-qualified throughout
-- (r.event_id, not event_id) to avoid "column reference is ambiguous"
-- errors — the same convention run_dedup_pass() already follows.
--
-- Defaults to dry run. Pass false to write changes.
--
-- Usage:
--   SELECT * FROM run_field_reconciliation_pass();        -- dry run
--   SELECT * FROM run_field_reconciliation_pass(false);   -- live
-- ============================================================

CREATE OR REPLACE FUNCTION run_field_reconciliation_pass(p_dry_run BOOLEAN DEFAULT true)
RETURNS TABLE (
  event_id          UUID,
  field             TEXT,
  old_value         TEXT,
  new_value         TEXT,
  winning_sightings INT,
  total_sightings   INT,
  vote_share        FLOAT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row RECORD;
BEGIN
  CREATE TEMP TABLE _reconcile_changes (
    event_id          UUID,
    field             TEXT,
    old_value         TEXT,
    new_value         TEXT,
    winning_sightings INT,
    total_sightings   INT,
    vote_share        FLOAT
  ) ON COMMIT DROP;

  WITH field_votes AS (
    -- Unpivot the three contested fields into one row per
    -- (event, field, value, confidence) so all three can be voted
    -- on with identical logic below.
    SELECT
      s.event_id,
      'name' AS field,
      s.raw_extraction->>'name' AS value,
      COALESCE(
        (s.raw_extraction->'field_confidence'->>'name')::FLOAT,
        s.extraction_confidence
      ) AS confidence
    FROM event_sightings s
    WHERE s.review_status != 'rejected'
      AND s.raw_extraction->>'name' IS NOT NULL

    UNION ALL

    SELECT
      s.event_id,
      'date_start',
      s.raw_extraction->>'date_start',
      COALESCE(
        (s.raw_extraction->'field_confidence'->>'date')::FLOAT,
        s.extraction_confidence
      )
    FROM event_sightings s
    WHERE s.review_status != 'rejected'
      AND s.raw_extraction->>'date_start' IS NOT NULL

    UNION ALL

    SELECT
      s.event_id,
      'location_name',
      s.raw_extraction->>'location_name',
      COALESCE(
        (s.raw_extraction->'field_confidence'->>'location')::FLOAT,
        s.extraction_confidence
      )
    FROM event_sightings s
    WHERE s.review_status != 'rejected'
      AND s.raw_extraction->>'location_name' IS NOT NULL
  ),
  -- Group near-identical readings (whitespace/case only) into one bucket.
  -- display_value keeps the highest-confidence original-cased reading —
  -- the vote picks the winning bucket, this picks its best-looking member.
  grouped AS (
    SELECT
      fv.event_id                                       AS event_id,
      fv.field                                           AS field,
      trim(lower(fv.value))                              AS value_key,
      (array_agg(fv.value ORDER BY fv.confidence DESC))[1] AS display_value,
      SUM(fv.confidence)                                 AS bucket_weight,
      COUNT(*)                                           AS bucket_n
    FROM field_votes fv
    GROUP BY fv.event_id, fv.field, trim(lower(fv.value))
  ),
  -- Rank buckets within each (event, field) by total confidence weight.
  -- field_total_weight / field_total_n are the denominators for vote_share;
  -- field_bucket_count lets the next step skip fields with no disagreement.
  ranked AS (
    SELECT
      g.event_id,
      g.field,
      g.display_value,
      g.bucket_weight,
      g.bucket_n,
      ROW_NUMBER() OVER (
        PARTITION BY g.event_id, g.field ORDER BY g.bucket_weight DESC, g.bucket_n DESC
      ) AS rnk,
      SUM(g.bucket_weight) OVER (PARTITION BY g.event_id, g.field) AS field_total_weight,
      SUM(g.bucket_n)      OVER (PARTITION BY g.event_id, g.field) AS field_total_n,
      COUNT(*)             OVER (PARTITION BY g.event_id, g.field) AS field_bucket_count
    FROM grouped g
  ),
  winners AS (
    SELECT
      r.event_id                                                   AS event_id,
      r.field                                                       AS field,
      r.display_value                                               AS new_value,
      r.bucket_n                                                    AS winning_sightings,
      r.field_total_n                                               AS total_sightings,
      ROUND((r.bucket_weight / NULLIF(r.field_total_weight, 0))::NUMERIC, 3)::FLOAT AS vote_share,
      CASE r.field
        WHEN 'name'          THEN e.name
        WHEN 'date_start'    THEN e.date_start::TEXT
        WHEN 'location_name' THEN e.location_name
      END AS old_value
    FROM ranked r
    JOIN events e ON e.id = r.event_id
    WHERE r.rnk = 1
      AND e.is_active = true
      -- Skip fields where every sighting already agrees — a single bucket
      -- means no disagreement, and its display_value will already match
      -- the stored value in the normal case.
      AND r.field_bucket_count > 1
  )
  INSERT INTO _reconcile_changes (event_id, field, old_value, new_value, winning_sightings, total_sightings, vote_share)
  SELECT w.event_id, w.field, w.old_value, w.new_value, w.winning_sightings, w.total_sightings, w.vote_share
  FROM winners w
  WHERE w.new_value IS DISTINCT FROM w.old_value;

  FOR v_row IN
    SELECT rc.event_id, rc.field, rc.old_value, rc.new_value, rc.winning_sightings, rc.total_sightings, rc.vote_share
    FROM _reconcile_changes rc
    ORDER BY rc.event_id, rc.field
  LOOP
    event_id          := v_row.event_id;
    field             := v_row.field;
    old_value         := v_row.old_value;
    new_value         := v_row.new_value;
    winning_sightings := v_row.winning_sightings;
    total_sightings   := v_row.total_sightings;
    vote_share        := v_row.vote_share;

    IF NOT p_dry_run THEN
      BEGIN
        IF v_row.field = 'name' THEN
          UPDATE events SET name = v_row.new_value, updated_at = now() WHERE id = v_row.event_id;
        ELSIF v_row.field = 'date_start' THEN
          UPDATE events SET date_start = v_row.new_value::DATE, updated_at = now() WHERE id = v_row.event_id;
        ELSIF v_row.field = 'location_name' THEN
          UPDATE events SET location_name = v_row.new_value, updated_at = now() WHERE id = v_row.event_id;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        -- A single malformed value (e.g. an unparseable date string that
        -- slipped through) shouldn't abort the whole pass — log and move on.
        RAISE WARNING 'run_field_reconciliation_pass: failed to write % for event %: %',
          v_row.field, v_row.event_id, SQLERRM;
      END;
    END IF;

    RETURN NEXT;
  END LOOP;

  -- Regenerate search_text for every touched event — name and
  -- location_name both feed it, and it's cheap and idempotent to
  -- refresh even for date_start-only changes.
  IF NOT p_dry_run THEN
    FOR v_row IN SELECT DISTINCT rc.event_id FROM _reconcile_changes rc LOOP
      PERFORM generate_search_text(v_row.event_id);
    END LOOP;
  END IF;
END;
$$;