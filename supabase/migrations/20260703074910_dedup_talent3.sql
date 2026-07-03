-- ============================================================
-- MIGRATION: talent merge lineage tracking
-- ============================================================
--
-- Prompted by: "should we reset is_active on talent, there are 97" --
-- and the honest answer is that flipping is_active alone does nothing
-- useful. merge_talent() rewrites event_talent.talent_id and
-- follows.talent_id to point at the canonical and never touches the
-- duplicate's own row again -- so a deactivated talent today has zero
-- rows pointing at it, and nothing anywhere records which canonical it
-- was absorbed into. Combined with the run_talent_dedup_pass tier-
-- separation bug (see migration_run_talent_dedup_pass_v2.sql), this
-- means the 97 already-merged records can't be retroactively sorted
-- into "safely same_event-merged" vs "riskily name_similarity-merged"
-- -- the information to do that was never captured.
--
-- This doesn't fix the 97. It makes sure this question never has to
-- be answered with "we don't know" again: every merge going forward
-- records who absorbed it, when, and under which tier.
--
-- New columns on talent:
--   merged_into_id    -- canonical this row was merged into, if any
--   merged_at         -- when
--   merge_match_type  -- 'same_event' | 'name_similarity' | NULL (manual)
--
-- merge_talent() gains an optional p_match_type parameter (NULL for
-- manual/ad-hoc calls, passed through by run_talent_dedup_pass for
-- pass-driven merges) and now stamps these on the duplicate's row as
-- its final step, instead of leaving it untouched.
-- ============================================================

ALTER TABLE talent ADD COLUMN IF NOT EXISTS merged_into_id   UUID REFERENCES talent(id) ON DELETE SET NULL;
ALTER TABLE talent ADD COLUMN IF NOT EXISTS merged_at        TIMESTAMPTZ;
ALTER TABLE talent ADD COLUMN IF NOT EXISTS merge_match_type TEXT;

CREATE INDEX IF NOT EXISTS idx_talent_merged_into ON talent(merged_into_id) WHERE merged_into_id IS NOT NULL;

-- Adding a parameter (even with a default) risks the same "cannot change
-- signature" class of error hit twice already this session with
-- run_field_reconciliation_pass()'s RETURNS TABLE changes. Safer to drop
-- explicitly than assume CREATE OR REPLACE handles it.
DROP FUNCTION IF EXISTS merge_talent(UUID, UUID);

CREATE OR REPLACE FUNCTION merge_talent(
  p_canonical_id UUID,
  p_duplicate_id UUID,
  p_match_type   TEXT DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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

  -- 1a. Preserve confirmed=true when discarding duplicate's conflicting
  --     row for an event canonical is also linked to.
  UPDATE event_talent ec
  SET confirmed = true
  FROM event_talent ed
  WHERE ec.talent_id = p_canonical_id
    AND ed.talent_id = p_duplicate_id
    AND ec.event_id = ed.event_id
    AND ed.confirmed = true
    AND ec.confirmed = false;

  -- 1b. event_talent -- canonical's row wins on conflict.
  DELETE FROM event_talent
  WHERE talent_id = p_duplicate_id
    AND event_id IN (
      SELECT event_id FROM event_talent WHERE talent_id = p_canonical_id
    );
  UPDATE event_talent SET talent_id = p_canonical_id WHERE talent_id = p_duplicate_id;

  -- 2. follows -- same pattern
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

  -- 4. Deactivate duplicate, recording lineage -- this is the fix:
  --    previously this row was just flipped inactive and never
  --    referenced again anywhere, making every past merge unauditable
  --    and unreversible after the fact.
  UPDATE talent SET
    is_active        = false,
    merged_into_id    = p_canonical_id,
    merged_at         = now(),
    merge_match_type  = p_match_type
  WHERE id = p_duplicate_id;
END;
$function$;

-- run_talent_dedup_pass() itself doesn't need a signature change --
-- it already calls merge_talent(canonical_id, duplicate_id); this just
-- adds the match_type so lineage is captured for pass-driven merges too.
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
  merged         BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_pair RECORD;
BEGIN
  CREATE TEMP TABLE _talent_dedup_pairs (
    canonical_id   UUID,
    canonical_name TEXT,
    duplicate_id   UUID,
    duplicate_name TEXT,
    match_type     TEXT
  ) ON COMMIT DROP;

  CREATE TEMP TABLE _talent_weight (
    talent_id UUID PRIMARY KEY,
    weight    FLOAT
  ) ON COMMIT DROP;

  INSERT INTO _talent_weight
  SELECT t.id, COALESCE(SUM(es.extraction_confidence), 0)
  FROM talent t
  LEFT JOIN event_talent et ON et.talent_id = t.id
  LEFT JOIN event_sightings es ON es.event_id = et.event_id
  WHERE t.is_active = true
  GROUP BY t.id;

  DECLARE
    v_component    RECORD;
    v_canonical_id UUID;
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
      SELECT t.id INTO v_canonical_id
      FROM talent t
      JOIN _talent_weight w ON w.talent_id = t.id
      WHERE t.id = ANY(v_component.member_ids)
      ORDER BY w.weight DESC, t.created_at ASC
      LIMIT 1;

      INSERT INTO _talent_dedup_pairs (canonical_id, canonical_name, duplicate_id, duplicate_name, match_type)
      SELECT v_canonical_id, tc.name, m.id, tm.name, 'same_event'
      FROM unnest(v_component.member_ids) AS m(id)
      JOIN talent tm ON tm.id = m.id
      JOIN talent tc ON tc.id = v_canonical_id
      WHERE m.id != v_canonical_id;
    END LOOP;
  END;

  DECLARE
    v_component    RECORD;
    v_canonical_id UUID;
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
      SELECT t.id INTO v_canonical_id
      FROM talent t
      JOIN _talent_weight w ON w.talent_id = t.id
      WHERE t.id = ANY(v_component.member_ids)
      ORDER BY w.weight DESC, t.created_at ASC
      LIMIT 1;

      INSERT INTO _talent_dedup_pairs (canonical_id, canonical_name, duplicate_id, duplicate_name, match_type)
      SELECT v_canonical_id, tc.name, m.id, tm.name, 'name_similarity'
      FROM unnest(v_component.member_ids) AS m(id)
      JOIN talent tm ON tm.id = m.id
      JOIN talent tc ON tc.id = v_canonical_id
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
    SELECT tdp.canonical_id, tdp.canonical_name, tdp.duplicate_id, tdp.duplicate_name, tdp.match_type
    FROM _talent_dedup_pairs tdp
    ORDER BY tdp.match_type, tdp.canonical_name
  LOOP
    canonical_id   := v_pair.canonical_id;
    canonical_name := v_pair.canonical_name;
    duplicate_id   := v_pair.duplicate_id;
    duplicate_name := v_pair.duplicate_name;
    match_type     := v_pair.match_type;
    merged         := false;

    IF (v_pair.match_type = 'same_event' AND p_run_same_event)
       OR (v_pair.match_type = 'name_similarity' AND p_run_name_similarity) THEN
      BEGIN
        -- match_type now threaded through so merge_talent() can record it.
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