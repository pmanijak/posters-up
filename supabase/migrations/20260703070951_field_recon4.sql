-- ============================================================
-- MIGRATION: cluster_event_name_buckets() + run_field_reconciliation_pass() v3
-- ============================================================
--
-- v3 adds confidence-gated automatic splitting, scoped narrowly to the
-- 'name' field. Previously (v2), any flagged field just filed a
-- 'possible_false_merge' report for human review — including cases
-- like Wild Child, where the false merge was clean and unambiguous but
-- the top-2-bucket comparison alone couldn't see it (six readings
-- splintered into five near-identical strings, none large enough to
-- be the runner-up).
--
-- ------------------------------------------------------------
-- WHY THIS WAS WORTH BUILDING (and why the scope is narrow)
-- ------------------------------------------------------------
-- run_talent_dedup_pass() already establishes the right shape for this
-- kind of decision: a same_event tier that's safe to run live, and a
-- cross_event tier that stays manual/dry-run only. Splitting deserves
-- the same two-tier treatment rather than being manual-only across the
-- board — a clean, well-supported 2+ cluster separation is a
-- mechanically confident call; an ambiguous one genuinely needs a
-- human, same as before.
--
-- The scope is deliberately narrow:
--   - Only the 'name' field triggers clustering/auto-split. name is
--     the field whose disagreement most directly indicates "these are
--     different real-world events" — a location_name or date_start
--     disagreement alone is more often just inconsistent metadata
--     about the SAME event (e.g. "The Crypt" vs "Ely's Crypt"), which
--     the ordinary plurality vote already handles correctly. If a
--     location_name/date_start field is ALSO flagged for an event that
--     just got auto-split on name, the split will usually resolve it
--     as a side effect; anything left over surfaces again next run.
--   - A cluster only counts as "real" (config: split_min_component_
--     sightings, default 2) if at least 2 sightings support it — a
--     single garbled misread can't spin up its own event on its own.
--     Sub-floor clusters stay attached to whichever event they were
--     already on; they're never split off, just left as noise.
--   - Exactly 2 or more real clusters → split every cluster except the
--     largest off into its own new event, sequentially, via the
--     existing split_event(). Fewer than 2 real clusters (i.e. the
--     flag fired but clustering can't confidently resolve it) falls
--     back to filing a pending report exactly as v2 did.
--
-- ------------------------------------------------------------
-- cluster_event_name_buckets()
-- ------------------------------------------------------------
-- Standalone, reusable connected-components clusterer over one event's
-- name-field sightings. Two readings are connected if their pg_trgm
-- similarity is >= p_connect_similarity (config: split_cluster_connect_
-- similarity, default 0.50 — deliberately higher than false_merge_
-- similarity_floor's 0.30, since this threshold decides what counts as
-- "the same real event," a stricter bar than "dissimilar enough to be
-- worth flagging"). Connectivity is transitive (standard graph
-- connected-components via recursive CTE reachability), so "Wild
-- Child," "Wild Child PNW Tour 2026," and "Wild Child — PNW Tour 2026
-- (Olympia)" correctly land in the same component even though no two
-- of them are bucketed identically by trim(lower()).
--
-- Callable directly as a preview/debug tool independent of the pass
-- function:
--   SELECT * FROM cluster_event_name_buckets('<event_id>');
-- ============================================================

INSERT INTO config (key, value, description) VALUES
  ('split_cluster_connect_similarity', '0.50',
   'cluster_event_name_buckets / run_field_reconciliation_pass: minimum
    pg_trgm similarity for two name-field readings to be treated as the
    same underlying event when clustering for automatic split
    decisions. Higher than false_merge_similarity_floor on purpose —
    this threshold decides identity, not just "worth flagging."'),
  ('split_min_component_sightings', '2',
   'run_field_reconciliation_pass: minimum sightings a clustered name
    component must have to count as a real candidate for automatic
    split. Sub-floor clusters are treated as noise and left attached
    to whichever event they were already on.')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION cluster_event_name_buckets(
  p_event_id           UUID,
  p_connect_similarity FLOAT DEFAULT NULL
)
RETURNS TABLE (
  component_id   TEXT,
  sample_value   TEXT,
  total_weight   FLOAT,
  sighting_count INT,
  sighting_ids   UUID[]
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_connect FLOAT;
BEGIN
  v_connect := p_connect_similarity;
  IF v_connect IS NULL THEN
    SELECT value::FLOAT INTO v_connect FROM config WHERE key = 'split_cluster_connect_similarity';
    v_connect := COALESCE(v_connect, 0.50);
  END IF;

  RETURN QUERY
  WITH RECURSIVE
  buckets AS (
    -- Same trim(lower()) exact-match bucketing as run_field_reconciliation_pass —
    -- these become the graph's nodes.
    SELECT
      trim(lower(s.raw_extraction->>'name'))                                                          AS value_key,
      (array_agg(s.raw_extraction->>'name' ORDER BY s.extraction_confidence DESC))[1]                 AS display_value,
      SUM(COALESCE((s.raw_extraction->'field_confidence'->>'name')::FLOAT, s.extraction_confidence))  AS bucket_weight,
      array_agg(s.id)                                                                                  AS bucket_sighting_ids,
      COUNT(*)                                                                                          AS bucket_n
    FROM event_sightings s
    WHERE s.event_id = p_event_id
      AND s.review_status != 'rejected'
      AND s.raw_extraction->>'name' IS NOT NULL
    GROUP BY trim(lower(s.raw_extraction->>'name'))
  ),
  edges AS (
    SELECT a.value_key AS from_key, b.value_key AS to_key
    FROM buckets a JOIN buckets b ON a.value_key < b.value_key
    WHERE similarity(a.display_value, b.display_value) >= v_connect
  ),
  all_edges AS (
    -- Undirected: traverse both directions.
    SELECT from_key, to_key FROM edges
    UNION ALL
    SELECT to_key, from_key FROM edges
  ),
  reach(start_key, reached_key) AS (
    SELECT value_key, value_key FROM buckets  -- every node reaches itself
    UNION
    SELECT r.start_key, e.to_key
    FROM reach r JOIN all_edges e ON e.from_key = r.reached_key
  ),
  -- Standard "label by minimum reachable node" trick: every node in the
  -- same connected component ends up with the same component_id.
  node_component AS (
    SELECT start_key AS value_key, MIN(reached_key) AS component_id
    FROM reach
    GROUP BY start_key
  ),
  -- Weight/count aggregated separately from sighting_ids to avoid the
  -- LATERAL unnest fan-out (below) inflating SUM(bucket_weight).
  component_summary AS (
    SELECT
      nc.component_id,
      SUM(b.bucket_weight)                                          AS total_weight,
      SUM(b.bucket_n)::INT                                          AS sighting_count,
      (array_agg(b.display_value ORDER BY b.bucket_weight DESC))[1] AS sample_value
    FROM buckets b
    JOIN node_component nc ON nc.value_key = b.value_key
    GROUP BY nc.component_id
  ),
  component_sightings AS (
    SELECT nc.component_id, array_agg(sid) AS sighting_ids
    FROM buckets b
    JOIN node_component nc ON nc.value_key = b.value_key
    CROSS JOIN LATERAL unnest(b.bucket_sighting_ids) AS sid
    GROUP BY nc.component_id
  )
  SELECT cs.component_id, cs.sample_value, cs.total_weight, cs.sighting_count, csi.sighting_ids
  FROM component_summary cs
  JOIN component_sightings csi ON csi.component_id = cs.component_id;
END;
$$;

-- Postgres cannot CREATE OR REPLACE when the return signature changes
-- (v3 adds the auto_split column). Drop the old signature first.
DROP FUNCTION IF EXISTS run_field_reconciliation_pass(BOOLEAN);

CREATE OR REPLACE FUNCTION run_field_reconciliation_pass(p_dry_run BOOLEAN DEFAULT true)
RETURNS TABLE (
  event_id             UUID,
  field                TEXT,
  old_value            TEXT,
  new_value            TEXT,
  winning_sightings    INT,
  total_sightings      INT,
  vote_share           FLOAT,
  flagged              BOOLEAN,
  runner_up_value      TEXT,
  runner_up_sightings  INT,
  auto_split           BOOLEAN  -- true = flagged AND resolved automatically via split_event(); false + flagged = still needs human review
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row                    RECORD;
  v_component              RECORD;
  v_split                  RECORD;
  v_similarity_floor       FLOAT;
  v_cluster_connect        FLOAT;
  v_min_component_sightings INT;
  v_real_components        INT;
  v_largest_component      TEXT;
  v_largest_weight         FLOAT;
  v_split_events           UUID[] := '{}';  -- events auto-split earlier in THIS run; see loop guard below
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
    event_id            := v_row.event_id;
    field               := v_row.field;
    old_value           := v_row.old_value;
    new_value           := v_row.new_value;
    winning_sightings   := v_row.winning_sightings;
    total_sightings     := v_row.total_sightings;
    vote_share          := v_row.vote_share;
    flagged             := v_row.flagged;
    runner_up_value     := v_row.runner_up_value;
    runner_up_sightings := v_row.runner_up_sightings;
    auto_split          := false;

    -- This event was already auto-split earlier in THIS run — its
    -- remaining queued rows (other fields) were computed against the
    -- pre-split sighting set and are now stale. Skip; the next
    -- scheduled run recomputes cleanly against the post-split state.
    IF v_row.event_id = ANY(v_split_events) THEN
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_row.flagged THEN
      IF v_row.field = 'name' THEN
        -- Count real (non-noise) clusters without executing anything yet —
        -- this doubles as both the dry-run preview and the live pre-check.
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

        auto_split := (v_real_components >= 2);
      END IF;

      IF NOT p_dry_run THEN
        IF auto_split THEN
          -- Split every real component except the largest off into its
          -- own new event, sequentially. Sighting sets across components
          -- are disjoint by construction, so calling split_event()
          -- repeatedly against the same (shrinking) p_event_id is safe.
          FOR v_component IN
            SELECT * FROM cluster_event_name_buckets(v_row.event_id, v_cluster_connect)
            WHERE sighting_count >= v_min_component_sightings
              AND component_id != v_largest_component
          LOOP
            BEGIN
              SELECT * INTO v_split
              FROM split_event(v_row.event_id, v_component.sighting_ids, false);

              -- split_event() already resolves any PRE-EXISTING pending
              -- false-merge report for this event. This is a separate,
              -- already-resolved audit entry — since v3 never files a
              -- pending report before attempting auto-split, this is
              -- often the ONLY record that an auto-split happened.
              INSERT INTO event_reports (event_id, report_type, note, reported_by, status, resolved_by, resolution_note, resolved_at)
              VALUES (
                v_row.event_id,
                'possible_false_merge',
                format('run_field_reconciliation_pass: auto-split candidate — field: name, cluster "%s" (%s sightings)',
                  v_component.sample_value, v_component.sighting_count),
                NULL,
                'resolved',
                'run_field_reconciliation_pass (auto-split)',
                format('Auto-split into new event %s ("%s") — connect similarity >= %s',
                  v_split.new_event_id, v_split.new_event_name, v_cluster_connect),
                now()
              );
            EXCEPTION WHEN OTHERS THEN
              RAISE WARNING 'run_field_reconciliation_pass: auto-split failed for event % component %: %',
                v_row.event_id, v_component.component_id, SQLERRM;
              auto_split := false;  -- at least one component failed; don't claim full success
            END;
          END LOOP;

          v_split_events := v_split_events || v_row.event_id;
        ELSE
          -- Fewer than 2 real clusters (or field wasn't 'name') — same
          -- fallback as v2: file a pending report for human review.
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
                'run_field_reconciliation_pass: field: %s — two dissimilar readings competing: "%s" (%s sighting(s)) vs "%s" (%s sighting(s)). Currently stored as "%s". Possible false merge, needs human review.',
                v_row.field, v_row.new_value, v_row.winning_sightings,
                v_row.runner_up_value, v_row.runner_up_sightings, v_row.old_value
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

  -- Regenerate search_text for events that got a field written directly
  -- (flagged = false rows). Auto-split events already had search_text
  -- regenerated inside split_event() itself via compute_event_confidence().
  -- Note: a flagged=false row belonging to an event that was ALSO
  -- auto-split via a separate 'name' row (and therefore skipped by the
  -- v_split_events guard above) will still trigger a redundant-but-
  -- harmless regen here, since this query doesn't know which rows were
  -- actually skipped — not worth the extra bookkeeping to avoid.
  IF NOT p_dry_run THEN
    FOR v_row IN
      SELECT DISTINCT rc.event_id FROM _reconcile_changes rc WHERE rc.flagged = false
    LOOP
      PERFORM generate_search_text(v_row.event_id);
    END LOOP;
  END IF;
END;
$$;