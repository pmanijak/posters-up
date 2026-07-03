-- ============================================================
-- MIGRATION: event_components_share_date/location() + run_field_reconciliation_pass() v5
-- ============================================================
--
-- v4 added a talent-overlap gate: shared talent between two candidate
-- split components blocks the auto-split, since that's the same signal
-- find_event_match()'s talent-anchor tier already trusts to correctly
-- merge same-event flyers with two different text elements (title vs.
-- lineup). It worked on the real data — a07dc92b's "One Day Closer to
-- Doom" / "Storm Boy..." split was correctly blocked once "Storm Boy"
-- appeared in both clusters' talent arrays.
--
-- But talent-only leaves a real gap: many flyers have no performer
-- field at all — community events, art shows, most of what Wild Child/
-- Pride Soirée/Juneteenth actually are. For those, talent overlap is
-- silent (no data on either side), which let a split through with zero
-- corroborating evidence either way.
--
-- v5 adds two more corroborating signals, same blocking direction as
-- talent (a match blocks the split; a mismatch or absence does NOT
-- greenlight one — a07dc92b's own two contradictory date_start readings
-- despite being one real event is a live example of why mismatch can't
-- be trusted as evidence of difference):
--
--   - event_components_share_date(): any date_start reading from one
--     component within 1 day of any reading from another. Reuses the
--     ±1 day tolerance find_event_match()/run_dedup_pass() already use
--     for date-based corroboration elsewhere in this schema.
--   - event_components_share_location(): any location_name reading
--     from one component with pg_trgm similarity >= 0.60 (config:
--     split_location_match_similarity) against a reading from another.
--     0.60 matches find_event_match()'s talent_anchor tier's own
--     location corroboration threshold — reused rather than invented,
--     for consistency with existing practice.
--
-- auto_split now requires: 2+ real clusters AND none of
-- {talent, date, location} corroborate "same event" across them.
--
-- Each clustering-based check independently re-runs
-- cluster_event_name_buckets() rather than sharing a precomputed
-- result — at this data scale (a handful of buckets per flagged
-- event) the redundant computation is trivial; not worth the added
-- complexity of threading shared state between functions.
-- ============================================================

INSERT INTO config (key, value, description) VALUES
  ('split_location_match_similarity', '0.60',
   'event_components_share_location: minimum pg_trgm similarity between
    two components'' location_name readings to treat them as
    corroborating "same event". Matches find_event_match()''s
    talent_anchor tier''s own location corroboration threshold.')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION event_components_share_date(
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

  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT c.component_id, (s.raw_extraction->>'date_start')::DATE AS date_val
      FROM cluster_event_name_buckets(p_event_id, v_connect) c
      CROSS JOIN LATERAL unnest(c.sighting_ids) AS sid
      JOIN event_sightings s ON s.id = sid
      WHERE c.sighting_count >= v_min_sightings
        AND s.raw_extraction->>'date_start' IS NOT NULL
    ) a
    JOIN (
      SELECT c.component_id, (s.raw_extraction->>'date_start')::DATE AS date_val
      FROM cluster_event_name_buckets(p_event_id, v_connect) c
      CROSS JOIN LATERAL unnest(c.sighting_ids) AS sid
      JOIN event_sightings s ON s.id = sid
      WHERE c.sighting_count >= v_min_sightings
        AND s.raw_extraction->>'date_start' IS NOT NULL
    ) b ON a.component_id < b.component_id
    WHERE ABS(a.date_val - b.date_val) <= 1
  ) INTO v_shared;

  RETURN COALESCE(v_shared, false);
END;
$$;

CREATE OR REPLACE FUNCTION event_components_share_location(
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
  v_match_floor   FLOAT;
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

  SELECT value::FLOAT INTO v_match_floor FROM config WHERE key = 'split_location_match_similarity';
  v_match_floor := COALESCE(v_match_floor, 0.60);

  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT c.component_id, s.raw_extraction->>'location_name' AS loc
      FROM cluster_event_name_buckets(p_event_id, v_connect) c
      CROSS JOIN LATERAL unnest(c.sighting_ids) AS sid
      JOIN event_sightings s ON s.id = sid
      WHERE c.sighting_count >= v_min_sightings
        AND s.raw_extraction->>'location_name' IS NOT NULL
    ) a
    JOIN (
      SELECT c.component_id, s.raw_extraction->>'location_name' AS loc
      FROM cluster_event_name_buckets(p_event_id, v_connect) c
      CROSS JOIN LATERAL unnest(c.sighting_ids) AS sid
      JOIN event_sightings s ON s.id = sid
      WHERE c.sighting_count >= v_min_sightings
        AND s.raw_extraction->>'location_name' IS NOT NULL
    ) b ON a.component_id < b.component_id
    WHERE similarity(lower(a.loc), lower(b.loc)) >= v_match_floor
  ) INTO v_shared;

  RETURN COALESCE(v_shared, false);
END;
$$;

-- Return signature changes again (date_overlap_detected, location_overlap_detected).
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
  auto_split               BOOLEAN,
  talent_overlap_detected  BOOLEAN,
  date_overlap_detected    BOOLEAN,
  location_overlap_detected BOOLEAN
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
  v_date_overlap            BOOLEAN;
  v_location_overlap        BOOLEAN;
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
    event_id                 := v_row.event_id;
    field                     := v_row.field;
    old_value                 := v_row.old_value;
    new_value                 := v_row.new_value;
    winning_sightings         := v_row.winning_sightings;
    total_sightings           := v_row.total_sightings;
    vote_share                := v_row.vote_share;
    flagged                   := v_row.flagged;
    runner_up_value           := v_row.runner_up_value;
    runner_up_sightings       := v_row.runner_up_sightings;
    auto_split                := false;
    talent_overlap_detected   := false;
    date_overlap_detected     := false;
    location_overlap_detected := false;

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
          v_talent_overlap   := event_components_share_talent(v_row.event_id, v_cluster_connect, v_min_component_sightings);
          v_date_overlap     := event_components_share_date(v_row.event_id, v_cluster_connect, v_min_component_sightings);
          v_location_overlap := event_components_share_location(v_row.event_id, v_cluster_connect, v_min_component_sightings);

          talent_overlap_detected   := v_talent_overlap;
          date_overlap_detected     := v_date_overlap;
          location_overlap_detected := v_location_overlap;

          auto_split := NOT (v_talent_overlap OR v_date_overlap OR v_location_overlap);
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
                format('Auto-split into new event %s ("%s") — connect similarity >= %s, no shared talent/date/location detected',
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
                CASE
                  WHEN talent_overlap_detected AND date_overlap_detected AND location_overlap_detected
                    THEN ' Clustering found separable name groups, but they share talent, a nearby date, AND a matching location — very likely the same event read multiple ways.'
                  WHEN talent_overlap_detected OR date_overlap_detected OR location_overlap_detected
                    THEN ' Clustering found separable name groups, but they share' ||
                         CASE WHEN talent_overlap_detected THEN ' talent' ELSE '' END ||
                         CASE WHEN date_overlap_detected THEN ' a nearby date' ELSE '' END ||
                         CASE WHEN location_overlap_detected THEN ' a matching location' ELSE '' END ||
                         ' — likely the same event read different ways, not two different events.'
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