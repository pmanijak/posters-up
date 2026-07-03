-- ============================================================
-- MIGRATION: run_talent_dedup_pass() v3 -- weight computation fix + margin gate
-- ============================================================
--
-- Found via a real bad merge in the live same_event queue: "Great
-- Comed" (garbled) was chosen as canonical over "Great Comets" (the
-- real name), and "The Makinas" over "The Makings". Both wrong.
--
-- Root cause, confirmed by direct data: _talent_weight computed
--   SUM(es.extraction_confidence)
--   FROM talent t
--   JOIN event_talent et ON et.talent_id = t.id
--   JOIN event_sightings es ON es.event_id = et.event_id
-- -- which sums confidence across EVERY sighting of EVERY event a
-- talent is linked to, not sightings that actually mention that
-- talent. Running this across the full talent table surfaced dozens
-- of exact-duplicate weight values shared by unrelated talent ids
-- (six different talents all showing weight 6.78, four showing 1.47,
-- etc.) -- proof the "weight" was measuring event-level photo volume,
-- not per-talent read confidence. A talent linked to a heavily-
-- photographed event inherited that event's whole confidence total
-- regardless of whether it was read in each photo.
--
-- Once corrected to sum confidence only from sightings whose
-- raw_extraction->'talent' array actually names the talent, "Great
-- Comets" (0.60) correctly outweighs "Great Comed" (0.58) -- but only
-- by ~3%. "The Makinas"/"The Makings" come out exactly tied (0.72 each).
-- So the fix has two parts:
--   1. Compute weight per-mention, not per-event-linkage.
--   2. Even correctly computed, a narrow margin isn't a confident
--      signal -- add talent_merge_min_weight_margin (config, default
--      0.10): if the "losing" member's weight is within 10% of the
--      canonical's, the pair is returned but flagged, and never
--      auto-merged regardless of which tier is enabled live.
--
-- flagged is a new RETURNS TABLE column. merge_talent() itself is
-- unchanged -- this bug lived entirely in canonical selection, not in
-- the merge mechanics.
--
-- Not addressed here (same scoping note as prior revisions): flagged
-- pairs have nowhere persistent to land for review -- no talent-level
-- equivalent of event_reports exists yet. For now, reviewing means
-- running `select * from run_talent_dedup_pass() where flagged` by
-- hand.
-- ============================================================

INSERT INTO config (key, value, description) VALUES
  ('talent_merge_min_weight_margin', '0.10',
   'run_talent_dedup_pass: a candidate duplicate is flagged (not
    auto-merged) if its per-mention confidence weight is within this
    fraction of the canonical''s weight -- e.g. 0.10 means the
    duplicate must be more than 10% below the canonical to be merged
    with confidence.')
ON CONFLICT (key) DO NOTHING;

DROP FUNCTION IF EXISTS run_talent_dedup_pass(BOOLEAN, BOOLEAN);

CREATE OR REPLACE FUNCTION run_talent_dedup_pass(
  p_run_same_event      BOOLEAN DEFAULT false,
  p_run_name_similarity BOOLEAN DEFAULT false
)
RETURNS TABLE (
  canonical_id   UUID,
  canonical_name TEXT,
  duplicate_id   UUID,
  duplicate_name TEXT,
  match_type     TEXT,
  flagged        BOOLEAN,  -- true = weight margin too narrow to trust automatically; never merged regardless of tier flags
  merged         BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_pair            RECORD;
  v_margin_fraction FLOAT;
BEGIN
  SELECT value::FLOAT INTO v_margin_fraction FROM config WHERE key = 'talent_merge_min_weight_margin';
  v_margin_fraction := COALESCE(v_margin_fraction, 0.10);

  CREATE TEMP TABLE _talent_dedup_pairs (
    canonical_id   UUID,
    canonical_name TEXT,
    duplicate_id   UUID,
    duplicate_name TEXT,
    match_type     TEXT,
    flagged        BOOLEAN
  ) ON COMMIT DROP;

  -- Per-talent confidence weight, computed once and reused for canonical
  -- selection in both tiers. Sums extraction_confidence ONLY from
  -- sightings whose raw_extraction->'talent' array actually names this
  -- talent (by canonical_name match) -- a true per-mention weight, not
  -- an artifact of how many events/sightings a talent happens to be
  -- linked to via event_talent.
  CREATE TEMP TABLE _talent_weight (
    talent_id UUID PRIMARY KEY,
    weight    FLOAT
  ) ON COMMIT DROP;

  INSERT INTO _talent_weight
  SELECT
    t.id,
    COALESCE(SUM(s.extraction_confidence), 0) AS weight
  FROM talent t
  LEFT JOIN event_sightings s
    ON s.review_status != 'rejected'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(s.raw_extraction->'talent', '[]'::jsonb)) te
      WHERE lower(trim(te->>'name')) = t.canonical_name
    )
  WHERE t.is_active = true
  GROUP BY t.id;

  -- ── Tier 1: same_event ──────────────────────────────────────────────
  DECLARE
    v_component        RECORD;
    v_canonical_id      UUID;
    v_canonical_weight  FLOAT;
  BEGIN
    FOR v_component IN
      WITH RECURSIVE
      edges AS (
        SELECT a.id AS a_id, b.id AS b_id
        FROM talent a
        JOIN talent b ON b.id > a.id AND b.is_active = true
        WHERE a.is_active = true
          AND similarity(lower(a.canonical_name), lower(b.canonical_name)) >= 0.50
          AND EXISTS (
            SELECT 1 FROM event_talent eta
            JOIN event_talent etb ON etb.event_id = eta.event_id AND etb.talent_id = b.id
            WHERE eta.talent_id = a.id
          )
          -- Concatenation guard: block if the longer of the two names is a
          -- run-on of a DIFFERENT, already-distinct talent also billed on
          -- the same shared event, glued onto one of this pair's names.
          -- Real case this catches: "Shelter Winston Hightowers" (one
          -- extraction pass failed to detect the line break between two
          -- adjacent lineup entries) vs "Winston Hightower" -- passes
          -- >=0.50 similarity and shares the event, but "Shelter" is
          -- independently a real, distinct performer on that same bill,
          -- not an OCR variant of "Winston Hightower". Co-occurrence
          -- proves relatedness, not that two strings name the same act.
          AND NOT EXISTS (
            SELECT 1
            FROM event_talent eta2
            JOIN event_talent etx ON etx.event_id = eta2.event_id
            JOIN talent x ON x.id = etx.talent_id
            WHERE eta2.talent_id = a.id
              AND x.id NOT IN (a.id, b.id)
              AND x.is_active = true
              AND length(x.canonical_name) >= 3
              AND (
                similarity(lower(x.canonical_name), lower(left(a.canonical_name, length(x.canonical_name)))) >= 0.70
                OR similarity(lower(x.canonical_name), lower(right(a.canonical_name, length(x.canonical_name)))) >= 0.70
                OR similarity(lower(x.canonical_name), lower(left(b.canonical_name, length(x.canonical_name)))) >= 0.70
                OR similarity(lower(x.canonical_name), lower(right(b.canonical_name, length(x.canonical_name)))) >= 0.70
              )
          )
      ),
      all_edges AS (
        SELECT a_id AS from_id, b_id AS to_id FROM edges
        UNION ALL
        SELECT b_id, a_id FROM edges
      ),
      nodes AS (
        SELECT a_id AS id FROM edges
        UNION
        SELECT b_id FROM edges
      ),
      reach(start_id, reached_id) AS (
        SELECT id, id FROM nodes
        UNION
        SELECT r.start_id, e.to_id
        FROM reach r JOIN all_edges e ON e.from_id = r.reached_id
      ),
      node_component AS (
        SELECT start_id AS talent_id, MIN(reached_id::text) AS component_id
        FROM reach GROUP BY start_id
      )
      SELECT nc.component_id, array_agg(nc.talent_id) AS member_ids
      FROM node_component nc
      GROUP BY nc.component_id
    LOOP
      SELECT t.id, w.weight INTO v_canonical_id, v_canonical_weight
      FROM talent t
      JOIN _talent_weight w ON w.talent_id = t.id
      WHERE t.id = ANY(v_component.member_ids)
      ORDER BY w.weight DESC, t.created_at ASC
      LIMIT 1;

      INSERT INTO _talent_dedup_pairs (canonical_id, canonical_name, duplicate_id, duplicate_name, match_type, flagged)
      SELECT
        v_canonical_id, tc.name, m.id, tm.name, 'same_event',
        (wm.weight > v_canonical_weight * (1 - v_margin_fraction))
      FROM unnest(v_component.member_ids) AS m(id)
      JOIN talent tm ON tm.id = m.id
      JOIN talent tc ON tc.id = v_canonical_id
      JOIN _talent_weight wm ON wm.talent_id = m.id
      WHERE m.id != v_canonical_id;
    END LOOP;
  END;

  -- ── Tier 2: name_similarity ─────────────────────────────────────────
  DECLARE
    v_component        RECORD;
    v_canonical_id      UUID;
    v_canonical_weight  FLOAT;
  BEGIN
    FOR v_component IN
      WITH RECURSIVE
      same_event_pairs AS (
        SELECT a.id AS a_id, b.id AS b_id
        FROM talent a
        JOIN talent b ON b.id > a.id AND b.is_active = true
        WHERE a.is_active = true
          AND similarity(lower(a.canonical_name), lower(b.canonical_name)) >= 0.50
          AND EXISTS (
            SELECT 1 FROM event_talent eta
            JOIN event_talent etb ON etb.event_id = eta.event_id AND etb.talent_id = b.id
            WHERE eta.talent_id = a.id
          )
      ),
      edges AS (
        SELECT a.id AS a_id, b.id AS b_id
        FROM talent a
        JOIN talent b ON b.id > a.id AND b.is_active = true
        WHERE a.is_active = true
          AND similarity(lower(a.canonical_name), lower(b.canonical_name)) >= 0.85
          AND NOT EXISTS (
            SELECT 1 FROM same_event_pairs sep
            WHERE sep.a_id = a.id AND sep.b_id = b.id
          )
      ),
      all_edges AS (
        SELECT a_id AS from_id, b_id AS to_id FROM edges
        UNION ALL
        SELECT b_id, a_id FROM edges
      ),
      nodes AS (
        SELECT a_id AS id FROM edges
        UNION
        SELECT b_id FROM edges
      ),
      reach(start_id, reached_id) AS (
        SELECT id, id FROM nodes
        UNION
        SELECT r.start_id, e.to_id
        FROM reach r JOIN all_edges e ON e.from_id = r.reached_id
      ),
      node_component AS (
        SELECT start_id AS talent_id, MIN(reached_id::text) AS component_id
        FROM reach GROUP BY start_id
      )
      SELECT nc.component_id, array_agg(nc.talent_id) AS member_ids
      FROM node_component nc
      GROUP BY nc.component_id
    LOOP
      SELECT t.id, w.weight INTO v_canonical_id, v_canonical_weight
      FROM talent t
      JOIN _talent_weight w ON w.talent_id = t.id
      WHERE t.id = ANY(v_component.member_ids)
      ORDER BY w.weight DESC, t.created_at ASC
      LIMIT 1;

      INSERT INTO _talent_dedup_pairs (canonical_id, canonical_name, duplicate_id, duplicate_name, match_type, flagged)
      SELECT
        v_canonical_id, tc.name, m.id, tm.name, 'name_similarity',
        (wm.weight > v_canonical_weight * (1 - v_margin_fraction))
      FROM unnest(v_component.member_ids) AS m(id)
      JOIN talent tm ON tm.id = m.id
      JOIN talent tc ON tc.id = v_canonical_id
      JOIN _talent_weight wm ON wm.talent_id = m.id
      WHERE m.id != v_canonical_id
        AND NOT EXISTS (
          SELECT 1 FROM _talent_dedup_pairs existing
          WHERE existing.match_type = 'same_event'
            AND ((existing.canonical_id = v_canonical_id AND existing.duplicate_id = m.id)
              OR (existing.canonical_id = m.id AND existing.duplicate_id = v_canonical_id))
        );
    END LOOP;
  END;

  FOR v_pair IN
    SELECT tdp.canonical_id, tdp.canonical_name, tdp.duplicate_id, tdp.duplicate_name, tdp.match_type, tdp.flagged
    FROM _talent_dedup_pairs tdp
    ORDER BY tdp.flagged DESC, tdp.match_type, tdp.canonical_name
  LOOP
    canonical_id   := v_pair.canonical_id;
    canonical_name := v_pair.canonical_name;
    duplicate_id   := v_pair.duplicate_id;
    duplicate_name := v_pair.duplicate_name;
    match_type     := v_pair.match_type;
    flagged        := v_pair.flagged;
    merged         := false;

    IF NOT v_pair.flagged
       AND ((v_pair.match_type = 'same_event' AND p_run_same_event)
         OR (v_pair.match_type = 'name_similarity' AND p_run_name_similarity)) THEN
      BEGIN
        PERFORM merge_talent(v_pair.canonical_id, v_pair.duplicate_id, v_pair.match_type);
        merged := true;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'run_talent_dedup_pass: merge failed for canonical % duplicate %: %',
          v_pair.canonical_id, v_pair.duplicate_id, SQLERRM;
      END;
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$$;