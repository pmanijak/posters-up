-- ============================================================
-- MIGRATION: event_components_share_talent() + run_field_reconciliation_pass() v4
-- ============================================================
--
-- v4 fixes a real false-positive discovered by running
-- cluster_event_name_buckets() against a07dc92b before trusting v3
-- live: "One Day Closer to Doom" and "Storm Boy & Coffin Proffits —
-- Misery" clustered as two clean, well-supported components (14 and 9
-- sightings) — but they're the SAME show. One flyer, two text
-- elements (title line vs. lineup line) that get inconsistently
-- extracted into the name field across different passes. v3 would
-- have auto-split a single real event in half.
--
-- This is exactly the failure ARCHITECTURE.md's talent-anchor sanity
-- check exists to prevent — just triggered in the opposite direction.
-- That check stops merge_events()/find_event_match() from OVER-merging
-- two different events that happen to share a headliner. The same
-- principle applies in reverse here: two candidate SPLIT components
-- that share talent are almost certainly the same event, not two
-- different ones — name-text similarity alone cannot see this,
-- because a title and its own lineup are, by definition, textually
-- unrelated. No similarity threshold tuning fixes that; a different
-- signal is required.
--
-- Fix: before auto-splitting, check whether any talent (by
-- canonical_name) is attested by sightings in MORE THAN ONE candidate
-- component. If so, suppress the auto-split entirely for that event —
-- fall back to filing a pending report, same as any other ambiguous
-- case. Shared talent is treated as strict, not fractional: any
-- overlap blocks the split, matching the existing conservative
-- "when in doubt" posture (ARCHITECTURE.md #6) rather than trying to
-- score how much overlap is "enough."
--
-- ------------------------------------------------------------
-- KNOWN LIMITATION — this is a probabilistic improvement, not a proof
-- ------------------------------------------------------------
-- This gate only works if the `talent` field was actually populated
-- consistently across both name-variants' sightings. If a flyer's
-- lineup text was crammed entirely into the `name` field with an
-- empty `talent` array (rather than the extraction prompt correctly
-- splitting it out), event_components_share_talent() will find no
-- overlap and incorrectly allow the split. Verify this specific case
-- against real data before trusting the gate broadly:
--   SELECT event_components_share_talent('a07dc92b-62b9-40e0-8924-36c44d504d33');
-- should return true. If it returns false, the talent arrays aren't
-- populated the way this fix assumes, and the gate needs a different
-- signal (or v3's auto-split needs to stay disabled) before going live.
-- ============================================================

CREATE OR REPLACE FUNCTION event_components_share_talent(
  p_event_id                UUID,
  p_connect_similarity      FLOAT DEFAULT NULL,
  p_min_component_sightings INT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_connect       FLOAT;
  v_min_sightings INT;
  v_shared        BOOLEAN;
BEGIN
  v_connect := p_connect_similarity;
  IF v_connect IS NULL THEN
    SELECT value::FLOAT INTO v_connect FROM config WHERE key = 'split_cluster_connect_similarity';
    v_connect := COALESCE(v_connect, 0.50);
  END IF;

  v_min_sightings := p_min_component_sightings;
  IF v_min_sightings IS NULL THEN
    SELECT value::INT INTO v_min_sightings FROM config WHERE key = 'split_min_component_sightings';
    v_min_sightings := COALESCE(v_min_sightings, 2);
  END IF;

  -- For every talent attested anywhere across the event's real
  -- (non-noise) components, check whether it's attested by sightings
  -- from more than one distinct component. Any such talent means at
  -- least two candidate components are linked by a shared act.
  SELECT EXISTS (
    SELECT x.talent_id
    FROM (
      SELECT c.component_id, t.id AS talent_id
      FROM cluster_event_name_buckets(p_event_id, v_connect) c
      CROSS JOIN LATERAL unnest(c.sighting_ids) AS sid
      JOIN event_sightings s ON s.id = sid
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.raw_extraction->'talent', '[]'::jsonb)) AS te
      JOIN talent t ON t.canonical_name = lower(trim(te->>'name'))
      WHERE c.sighting_count >= v_min_sightings
    ) x
    GROUP BY x.talent_id
    HAVING COUNT(DISTINCT x.component_id) > 1
  ) INTO v_shared;

  RETURN COALESCE(v_shared, false);
END;
$$;

-- Return signature changes again (new talent_overlap_detected column).
DROP FUNCTION IF EXISTS run_field_reconciliation_pass(BOOLEAN);

CREATE OR REPLACE FUNCTION run_field_reconciliation_pass(p_dry_run BOOLEAN DEFAULT true)
RETURNS TABLE (
  event_id                 UUID,
  field                    TEXT,
  old_value                TEXT,
  new_value                TEXT,
  winning_sightings        INT,
  total_sightings          INT,
  vote_share               FLOAT,
  flagged                  BOOLEAN,
  runner_up_value          TEXT,
  runner_up_sightings      INT,
  auto_split               BOOLEAN,  -- true = flagged AND resolved automatically via split_event()
  talent_overlap_detected  BOOLEAN   -- true = clustering found 2+ real components but shared talent blocked the split; needs human judgment on whether the overlap is coincidental
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row                     RECORD;
  v_component               RECORD;
  v_split                   RECORD;
  v_similarity_floor        FLOAT;
  v_cluster_connect         FLOAT;
  v_min_component_sightings INT;
  v_real_components         INT;
  v_largest_component       TEXT;
  v_largest_weight          FLOAT;
  v_talent_overlap          BOOLEAN;
  v_split_events            UUID[] := '{}';
BEGIN
  SELECT value::FLOAT INTO v_similarity_floor FROM config WHERE key = 'false_merge_similarity_floor';
  v_similarity_floor := COALESCE(v_similarity_floor, 0.30);

  SELECT value::FLOAT INTO v_cluster_connect FROM config WHERE key = 'split_cluster_connect_similarity';
  v_cluster_connect := COALESCE(v_cluster_connect, 0.50);

  SELECT value::INT INTO v_min_component_sightings FROM config WHERE key = 'split_min_component_sightings';
  v_min_component_sightings := COALESCE(v_min_component_sightings, 2);

  CREATE TEMP TABLE _reconcile_changes (
    event_id            UUID,
    field               TEXT,
    old_value           TEXT,
    new_value           TEXT,
    winning_sightings   INT,
    total_sightings     INT,
    vote_share          FLOAT,
    flagged             BOOLEAN,
    runner_up_value     TEXT,
    runner_up_sightings INT
  ) ON COMMIT DROP;

  WITH field_votes AS (
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
  top_two AS (
    SELECT
      w.event_id, w.field, w.display_value AS winner_value,
      w.bucket_n AS winning_sightings, w.field_total_n AS total_sightings,
      w.field_total_weight, w.bucket_weight,
      w.field_bucket_count,
      ru.display_value AS runner_up_value,
      ru.bucket_n       AS runner_up_sightings
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
      CASE
        WHEN t.field_bucket_count <= 1 THEN false
        WHEN similarity(lower(t.winner_value), lower(t.runner_up_value)) < v_similarity_floor THEN true
        ELSE false
      END AS flagged,
      t.runner_up_value                                              AS runner_up_value,
      t.runner_up_sightings                                          AS runner_up_sightings
    FROM top_two t
    JOIN events e ON e.id = t.event_id
    WHERE e.is_active = true
      AND t.field_bucket_count > 1
  )
  INSERT INTO _reconcile_changes (event_id, field, old_value, new_value, winning_sightings, total_sightings, vote_share, flagged, runner_up_value, runner_up_sightings)
  SELECT w.event_id, w.field, w.old_value, w.new_value, w.winning_sightings, w.total_sightings, w.vote_share, w.flagged, w.runner_up_value, w.runner_up_sightings
  FROM winners w
  WHERE w.flagged = true
     OR w.new_value IS DISTINCT FROM w.old_value;

  FOR v_row IN
    SELECT rc.event_id, rc.field, rc.old_value, rc.new_value, rc.winning_sightings,
           rc.total_sightings, rc.vote_share, rc.flagged, rc.runner_up_value, rc.runner_up_sightings
    FROM _reconcile_changes rc
    ORDER BY rc.flagged DESC, rc.event_id, rc.field
  LOOP
    event_id                := v_row.event_id;
    field                    := v_row.field;
    old_value                := v_row.old_value;
    new_value                := v_row.new_value;
    winning_sightings        := v_row.winning_sightings;
    total_sightings          := v_row.total_sightings;
    vote_share               := v_row.vote_share;
    flagged                  := v_row.flagged;
    runner_up_value          := v_row.runner_up_value;
    runner_up_sightings      := v_row.runner_up_sightings;
    auto_split               := false;
    talent_overlap_detected  := false;

    IF v_row.event_id = ANY(v_split_events) THEN
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_row.flagged THEN
      IF v_row.field = 'name' THEN
        v_real_components := 0;
        v_largest_component := NULL;
        v_largest_weight := -1;

        FOR v_component IN
          SELECT * FROM cluster_event_name_buckets(v_row.event_id, v_cluster_connect)
          WHERE sighting_count >= v_min_component_sightings
        LOOP
          v_real_components := v_real_components + 1;
          IF v_component.total_weight > v_largest_weight THEN
            v_largest_weight := v_component.total_weight;
            v_largest_component := v_component.component_id;
          END IF;
        END LOOP;

        IF v_real_components >= 2 THEN
          v_talent_overlap := event_components_share_talent(v_row.event_id, v_cluster_connect, v_min_component_sightings);
          talent_overlap_detected := v_talent_overlap;
          auto_split := NOT v_talent_overlap;
        END IF;
      END IF;

      IF NOT p_dry_run THEN
        IF auto_split THEN
          FOR v_component IN
            SELECT * FROM cluster_event_name_buckets(v_row.event_id, v_cluster_connect)
            WHERE sighting_count >= v_min_component_sightings
              AND component_id != v_largest_component
          LOOP
            BEGIN
              SELECT * INTO v_split
              FROM split_event(v_row.event_id, v_component.sighting_ids, false);

              INSERT INTO event_reports (event_id, report_type, note, reported_by, status, resolved_by, resolution_note, resolved_at)
              VALUES (
                v_row.event_id,
                'possible_false_merge',
                format('run_field_reconciliation_pass: auto-split candidate — field: name, cluster "%s" (%s sightings)',
                  v_component.sample_value, v_component.sighting_count),
                NULL,
                'resolved',
                'run_field_reconciliation_pass (auto-split)',
                format('Auto-split into new event %s ("%s") — connect similarity >= %s, no shared talent detected',
                  v_split.new_event_id, v_split.new_event_name, v_cluster_connect),
                now()
              );
            EXCEPTION WHEN OTHERS THEN
              RAISE WARNING 'run_field_reconciliation_pass: auto-split failed for event % component %: %',
                v_row.event_id, v_component.component_id, SQLERRM;
              auto_split := false;
            END;
          END LOOP;

          v_split_events := v_split_events || v_row.event_id;
        ELSE
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
                'run_field_reconciliation_pass: field: %s — two dissimilar readings competing: "%s" (%s sighting(s)) vs "%s" (%s sighting(s)). Currently stored as "%s".%s Possible false merge, needs human review.',
                v_row.field, v_row.new_value, v_row.winning_sightings,
                v_row.runner_up_value, v_row.runner_up_sightings, v_row.old_value,
                CASE WHEN talent_overlap_detected
                  THEN ' Clustering found separable name groups but they share talent — likely the same event read two different ways (e.g. title vs. lineup), not two different events.'
                  ELSE ''
                END
              ),
              NULL,
              'pending'
            );
          END IF;
        END IF;
      END IF;
    ELSE
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
          RAISE WARNING 'run_field_reconciliation_pass: failed to write % for event %: %',
            v_row.field, v_row.event_id, SQLERRM;
        END;
      END IF;
    END IF;

    RETURN NEXT;
  END LOOP;

  IF NOT p_dry_run THEN
    FOR v_row IN
      SELECT DISTINCT rc.event_id FROM _reconcile_changes rc WHERE rc.flagged = false
    LOOP
      PERFORM generate_search_text(v_row.event_id);
    END LOOP;
  END IF;
END;
$$;