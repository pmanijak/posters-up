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
-- ------------------------------------------------------------
-- FALSE-MERGE GUARD
-- ------------------------------------------------------------
-- A field with no dominant reading isn't always OCR noise on one flyer —
-- it can mean two genuinely different flyers were merged into one event
-- by find_event_match()/run_dedup_pass() (observed in practice: a
-- Juneteenth event and an unrelated band show both extracted from the
-- same venue's lobby board, matched on location_anchor, merged under
-- one event_id). Reconciling a field in that case doesn't fix
-- anything — it silently picks one of two unrelated events' names and
-- buries the fact that a bad merge happened.
--
-- Distinguishing signal: real OCR noise produces buckets that are
-- textually *similar* to each other even after failing the exact-match
-- grouping ("Tom Rawson" vs "Ton Rauson"). A false merge produces
-- buckets that are textually *unrelated* ("Juneteenth — Celebrate
-- Freedom..." vs "Turnover / Narrow Head..."). pg_trgm's similarity()
-- — already load-bearing for dedup and talent dedup elsewhere in this
-- schema — separates the two cases cheaply.
--
-- If the top two buckets for a field score below
-- false_merge_similarity_floor (config, default 0.30), the field is
-- NOT reconciled. Instead, one 'possible_false_merge' row is written to
-- event_reports (once per event, not once per field) so it surfaces in
-- the existing human-review queue rather than requiring a separate
-- process someone has to remember to run.
--
-- Automating away the review step itself isn't safe here — a false
-- merge needs a decision (split? which event keeps which sightings?)
-- that the same statistical machinery flagging it can't safely make.
-- Automating the *detection and routing* is the right stopping point.
--
-- ------------------------------------------------------------
-- VOTING MECHANISM
-- ------------------------------------------------------------
--   1. Unpivot name/date_start/location_name from raw_extraction into
--      one row per (event, field, value, confidence). Confidence comes
--      from raw_extraction->field_confidence when present (name, date,
--      location all have per-field scores), falling back to the
--      sighting's overall extraction_confidence otherwise.
--   2. Group by trim(lower(value)) to absorb whitespace/casing noise
--      without merging genuinely different OCR misreads into the same
--      bucket — "Tom Rawson" and "Ton Rauson" stay separate buckets on
--      purpose. This is intentionally coarser than fuzzy clustering;
--      similarity() is applied afterward, only for the false-merge
--      check, not for grouping itself.
--   3. Within each bucket, keep the highest-confidence original-cased
--      reading as the display value.
--   4. Sum confidence per bucket; the bucket with the highest total
--      weight wins, gated by the false-merge check above. Only
--      surfaced when the winner differs from the value currently
--      stored on the event.
--
-- Naming note: every RETURNS TABLE column below is implicitly a
-- PL/pgSQL variable inside this function body (event_id, field,
-- old_value, new_value, ...). Every SQL reference to a same-named
-- table/CTE column is therefore explicitly alias-qualified throughout
-- (r.event_id, not event_id) to avoid "column reference is ambiguous"
-- errors — the same convention run_dedup_pass() already follows.
--
-- Defaults to dry run. Pass false to write changes and file reports.
--
-- Usage:
--   SELECT * FROM run_field_reconciliation_pass();        -- dry run
--   SELECT * FROM run_field_reconciliation_pass(false);   -- live
-- ============================================================

INSERT INTO config (key, value, description) VALUES
  ('false_merge_similarity_floor', '0.30',
   'run_field_reconciliation_pass: below this pg_trgm similarity between
    the top two competing readings for a field, treat as a possible
    false merge instead of picking a winner')
ON CONFLICT (key) DO NOTHING;

-- Postgres cannot CREATE OR REPLACE a function when the return signature
-- changes (this version adds the `flagged` column to the RETURNS TABLE
-- shape). Drop the old signature explicitly before recreating.
DROP FUNCTION IF EXISTS run_field_reconciliation_pass(BOOLEAN);

CREATE OR REPLACE FUNCTION run_field_reconciliation_pass(p_dry_run BOOLEAN DEFAULT true)
RETURNS TABLE (
  event_id          UUID,
  field             TEXT,
  old_value         TEXT,
  new_value         TEXT,
  winning_sightings INT,
  total_sightings   INT,
  vote_share        FLOAT,
  flagged           BOOLEAN   -- true = possible false merge, not reconciled; see runner_up_similarity
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row RECORD;
  v_similarity_floor FLOAT;
BEGIN
  SELECT value::FLOAT INTO v_similarity_floor
  FROM config WHERE key = 'false_merge_similarity_floor';
  v_similarity_floor := COALESCE(v_similarity_floor, 0.30);

  CREATE TEMP TABLE _reconcile_changes (
    event_id          UUID,
    field             TEXT,
    old_value         TEXT,
    new_value         TEXT,
    winning_sightings INT,
    total_sightings   INT,
    vote_share        FLOAT,
    flagged           BOOLEAN
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
      fv.event_id                                          AS event_id,
      fv.field                                              AS field,
      trim(lower(fv.value))                                 AS value_key,
      (array_agg(fv.value ORDER BY fv.confidence DESC))[1]  AS display_value,
      SUM(fv.confidence)                                    AS bucket_weight,
      COUNT(*)                                              AS bucket_n
    FROM field_votes fv
    GROUP BY fv.event_id, fv.field, trim(lower(fv.value))
  ),
  -- Rank buckets within each (event, field) by total confidence weight.
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
  -- Pull the winner (rnk=1) and runner-up (rnk=2) side by side so the
  -- false-merge similarity check can compare them directly.
  top_two AS (
    SELECT
      w.event_id, w.field, w.display_value AS winner_value,
      w.bucket_n AS winning_sightings, w.field_total_n AS total_sightings,
      w.field_total_weight, w.bucket_weight,
      w.field_bucket_count,
      ru.display_value AS runner_up_value
    FROM ranked w
    LEFT JOIN ranked ru
      ON ru.event_id = w.event_id AND ru.field = w.field AND ru.rnk = 2
    WHERE w.rnk = 1
  ),
  winners AS (
    SELECT
      t.event_id                                                    AS event_id,
      t.field                                                        AS field,
      t.winner_value                                                 AS new_value,
      t.winning_sightings                                            AS winning_sightings,
      t.total_sightings                                              AS total_sightings,
      ROUND((t.bucket_weight / NULLIF(t.field_total_weight, 0))::NUMERIC, 3)::FLOAT AS vote_share,
      CASE t.field
        WHEN 'name'          THEN e.name
        WHEN 'date_start'    THEN e.date_start::TEXT
        WHEN 'location_name' THEN e.location_name
      END AS old_value,
      -- No runner-up (field_bucket_count = 1) means unanimous agreement,
      -- not a merge risk — similarity is moot, never flag those.
      CASE
        WHEN t.field_bucket_count <= 1 THEN false
        WHEN similarity(lower(t.winner_value), lower(t.runner_up_value)) < v_similarity_floor THEN true
        ELSE false
      END AS flagged
    FROM top_two t
    JOIN events e ON e.id = t.event_id
    WHERE e.is_active = true
      -- Skip fields where every sighting already agrees.
      AND t.field_bucket_count > 1
  )
  INSERT INTO _reconcile_changes (event_id, field, old_value, new_value, winning_sightings, total_sightings, vote_share, flagged)
  SELECT w.event_id, w.field, w.old_value, w.new_value, w.winning_sightings, w.total_sightings, w.vote_share, w.flagged
  FROM winners w
  WHERE w.flagged = true
     OR w.new_value IS DISTINCT FROM w.old_value;

  FOR v_row IN
    SELECT rc.event_id, rc.field, rc.old_value, rc.new_value, rc.winning_sightings,
           rc.total_sightings, rc.vote_share, rc.flagged
    FROM _reconcile_changes rc
    ORDER BY rc.flagged DESC, rc.event_id, rc.field
  LOOP
    event_id          := v_row.event_id;
    field             := v_row.field;
    old_value         := v_row.old_value;
    new_value         := v_row.new_value;
    winning_sightings := v_row.winning_sightings;
    total_sightings   := v_row.total_sightings;
    vote_share        := v_row.vote_share;
    flagged           := v_row.flagged;

    IF NOT p_dry_run THEN
      IF v_row.flagged THEN
        -- One report per (event, field) possible false merge. ON CONFLICT
        -- isn't available here (no natural unique key on event_reports),
        -- so guard with a pending-report existence check instead —
        -- avoids re-filing the same report every time the pass reruns.
        IF NOT EXISTS (
          SELECT 1 FROM event_reports er
          WHERE er.event_id = v_row.event_id
            AND er.report_type = 'possible_false_merge'
            AND er.status = 'pending'
            AND er.note LIKE '%field: ' || v_row.field || '%'
        ) THEN
          INSERT INTO event_reports (event_id, report_type, note, reported_by, status)
          VALUES (
            v_row.event_id,
            'possible_false_merge',
            format(
              'run_field_reconciliation_pass: field: %s — competing readings too dissimilar to vote on ("%s" vs "%s"). Possible false merge, needs human review.',
              v_row.field, v_row.new_value, v_row.old_value
            ),
            NULL,  -- system-filed, not a user report
            'pending'
          );
        END IF;
      ELSE
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
    END IF;

    RETURN NEXT;
  END LOOP;

  -- Regenerate search_text for every event that actually got a field
  -- written (not flagged-only events — nothing changed on those).
  IF NOT p_dry_run THEN
    FOR v_row IN
      SELECT DISTINCT rc.event_id FROM _reconcile_changes rc WHERE rc.flagged = false
    LOOP
      PERFORM generate_search_text(v_row.event_id);
    END LOOP;
  END IF;
END;
$$;