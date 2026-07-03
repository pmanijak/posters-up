-- ============================================================
-- MIGRATION: run_talent_dedup_pass() v2 + merge_talent() fix
-- ============================================================
--
-- Four fixes, found by reading the actual source (previously this
-- function had only ever been described in handoff.md prose, never
-- actually reviewed):
--
-- 1. CRITICAL: p_dry_run did not distinguish tiers. Both same_event
--    (Tier 1, safe -- co-occurrence corroborates) and name_similarity
--    (Tier 2, no corroboration beyond a 0.85 string-similarity bar --
--    explicitly documented as "dry-run-only, human review required")
--    were merged live together whenever dry_run=false. Wiring this
--    function into extract with dry_run:false therefore turned BOTH
--    tiers live, not just the safe one. Fixed by replacing the single
--    p_dry_run with two independent booleans, both defaulting to
--    false (pure report, matching the original safe intent) --
--    p_run_same_event and p_run_name_similarity must each be
--    explicitly opted into.
--
-- 2. Chained/tangled merges could silently drop a cluster member.
--    Pairs were resolved independently, using weight comparisons
--    computed before any merge ran. A 3+-way similarity cluster
--    (e.g. this session's real "Storm Boy" lineup, which OCR'd as
--    "30 Coffin" / "38 Coffin" / "3D Coffin" / "Jo Coffin" / "Coffin
--    Proffits") could produce two independent pairwise merges that
--    both try to claim the same duplicate; whichever runs second hits
--    merge_talent()'s own is_active guard and silently no-ops (RAISE
--    NOTICE only), leaving that member never actually merged anywhere.
--    Fixed with the same connected-components approach already used
--    for cluster_event_name_buckets(): each tier's similarity graph is
--    resolved into components first, ONE canonical is chosen per
--    component (highest total confidence weight, ties broken by
--    created_at), and every other member merges directly into that
--    same canonical -- no pairwise chaining, no split-brain.
--
-- 3. merge_talent() could silently downgrade a confirmed=true link.
--    If canonical and duplicate both had an event_talent row for the
--    same event, the original DELETE-then-UPDATE unconditionally kept
--    canonical's row and discarded duplicate's -- including its
--    confirmed status, even if duplicate's was the confirmed one.
--    Fixed: confirmed is now OR'd onto canonical's row before the
--    conflicting duplicate row is discarded.
--
-- 4. No exception handling around merge_talent() calls. One failing
--    merge would roll back the entire pass, not just that pair. Fixed
--    with the same BEGIN/EXCEPTION/RAISE WARNING pattern already used
--    in run_field_reconciliation_pass().
--
-- Deliberately NOT addressed here (scope containment, not oversights):
--   - Tier 2 still has zero corroborating signal beyond name
--     similarity. Given talent names are typically 1-4 words,
--     pg_trgm similarity is structurally noisier for them than for
--     longer event names -- a real risk, but fixing (2) tier
--     separation restores the ORIGINAL safe default (both tiers
--     report-only unless explicitly enabled) without requiring new
--     corroboration logic to be designed and tested first.
--   - No audit trail of what actually got merged. Unlike
--     run_field_reconciliation_pass()'s auto-split path, which writes
--     an already-resolved event_reports row for visibility, a
--     successful merge_talent() call here leaves no record beyond the
--     row this function already returns to its caller -- and since
--     extract's background call only does console.warn on error, a
--     successful live merge is currently unlogged anywhere durable.
-- ============================================================

-- Argument list changes (single p_dry_run -> two booleans). Postgres
-- would otherwise treat this as a new overload and leave the old,
-- dangerous single-parameter version still callable.
DROP FUNCTION IF EXISTS run_talent_dedup_pass(BOOLEAN);

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

  -- Per-talent confidence weight, computed once and reused for canonical
  -- selection in both tiers: SUM(extraction_confidence) across all
  -- sightings of every event a talent appears on.
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

  -- ── Tier 1: same_event ──────────────────────────────────────────────
  -- Both talent linked to the same event with similar names. Resolved
  -- as connected components rather than independent pairs -- see
  -- header note (2).
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
        SELECT start_id AS talent_id, MIN(reached_id) AS component_id
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

  -- ── Tier 2: name_similarity ─────────────────────────────────────────
  -- Cross-event, no co-occurrence signal, high bar (0.85). Same
  -- connected-components treatment; skips any pair already captured
  -- under Tier 1 to avoid double-reporting one relationship twice.
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
        SELECT start_id AS talent_id, MIN(reached_id) AS component_id
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
        PERFORM merge_talent(v_pair.canonical_id, v_pair.duplicate_id);
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

CREATE OR REPLACE FUNCTION merge_talent(p_canonical_id uuid, p_duplicate_id uuid)
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
  --     row for an event canonical is also linked to -- a merge should
  --     never silently downgrade a link that was already confirmed.
  UPDATE event_talent ec
  SET confirmed = true
  FROM event_talent ed
  WHERE ec.talent_id = p_canonical_id
    AND ed.talent_id = p_duplicate_id
    AND ec.event_id = ed.event_id
    AND ed.confirmed = true
    AND ec.confirmed = false;

  -- 1b. event_talent -- canonical's row wins on conflict; delete dup's
  --     conflicting rows first (confirmed status already preserved above)
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

  -- 4. Deactivate duplicate
  UPDATE talent SET is_active = false WHERE id = p_duplicate_id;
END;
$function$;