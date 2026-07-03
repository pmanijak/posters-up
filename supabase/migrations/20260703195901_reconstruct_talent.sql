-- ============================================================
-- MIGRATION: reconstruct_talent_from_sightings()
-- ============================================================
--
-- run_talent_dedup_pass() only ever considers WHERE is_active = true —
-- a merged-away duplicate is permanently invisible to it, so re-running
-- even the fully fixed version can never undo an earlier bad merge
-- (confirmed empirically: "Great Comets" and "The Makings", both
-- is_active = false with zero event_talent rows, are structurally
-- unreachable by that function no matter how correct its algorithm is).
--
-- This function starts from a different, more powerful ground truth:
-- event_sightings.raw_extraction->'talent', which is immutable and
-- untouched by any merge, dedup pass, or this function's own prior
-- runs. It re-derives what talent identity SHOULD look like from
-- scratch every time, entirely independent of talent.is_active or
-- current event_talent state, then reconciles current reality against
-- that fresh truth.
--
-- ------------------------------------------------------------
-- WHY ANCHOR SELECTION WORKS THE WAY IT DOES
-- ------------------------------------------------------------
-- For each cluster, the anchor is the EXISTING talent row (active or
-- not) holding the most current event_talent relationships -- this
-- minimizes how much relationship re-pointing is needed, not an
-- attempt to guess which spelling is "more correct" (that's decided
-- separately, from confidence, below). The anchor's name/canonical_name
-- is then updated to the cluster's actual highest-confidence spelling,
-- REGARDLESS of which row was chosen as anchor for relationship-
-- continuity reasons. This is the generalized form of the manual fix
-- applied to Great Comed/Great Comets and The Makinas/The Makings:
-- since both wrongly-canonical rows already held the (only) relevant
-- relationship, fixing them was a pure rename, never a re-pointing
-- job. That won't always be true (a wrongly-canonical row COULD hold
-- relationships across several events while the correctly-spelled but
-- merged-away row holds none, or vice versa with real conflicts) --
-- for those cases, every non-anchor cluster member is folded into the
-- anchor via the same relationship-migration merge_talent() already
-- uses, then a direct upsert from raw mentions re-asserts the best-
-- confidence role/billing_position per event across the WHOLE cluster
-- (more accurate than merge_talent()'s own conflict handling, which
-- keeps whichever row happened to be canonical without comparing
-- mention quality).
--
-- ------------------------------------------------------------
-- WHY BOTH TIERS ARE COMBINED INTO ONE GRAPH HERE
-- ------------------------------------------------------------
-- run_talent_dedup_pass() keeps same_event and name_similarity
-- administratively separate because that separation controls what's
-- safe to execute UNATTENDED. This function has no live/unattended
-- mode at all -- every result is a dry-run diff reviewed by a human
-- before p_dry_run := false ever runs -- so there's no reason to
-- withhold name_similarity's evidence from cluster formation. Combining
-- both produces more complete, more accurate clusters; the review step
-- is what keeps this safe, not tier separation.
--
-- Same concatenation guard as run_talent_dedup_pass() (>=0.70 prefix/
-- suffix match against a third, distinct co-billed name), same 0.50 /
-- 0.85 thresholds -- these mirror that function's tiers exactly and
-- are intentionally left as the same hardcoded literals (the original
-- tiers were never made config-driven either; not introducing that
-- inconsistency here).
--
-- follows is deliberately left untouched -- confirmed unused (no UI
-- writes to it, notification delivery not built).
--
-- Defaults to dry run. Given this can touch every talent row in the
-- table, treat p_dry_run := false with real caution -- read the full
-- diff first, not just a sample.
--
-- Usage:
--   select * from reconstruct_talent_from_sightings();        -- dry run
--   select * from reconstruct_talent_from_sightings(false);   -- live
-- ============================================================

CREATE OR REPLACE FUNCTION reconstruct_talent_from_sightings(p_dry_run BOOLEAN DEFAULT true)
RETURNS TABLE (
  change_type TEXT,   -- 'create' | 'resurrect' | 'rename' | 'deactivate' | 'relink'
  talent_id   UUID,
  talent_name TEXT,   -- target/new name where relevant
  detail      TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_cluster              RECORD;
  v_anchor_id             UUID;
  v_anchor_current_name   TEXT;
  v_anchor_is_active      BOOLEAN;
  v_member                RECORD;
BEGIN
  -- ── Step A: every talent mention from every non-rejected sighting ────
  CREATE TEMP TABLE _raw_mentions ON COMMIT DROP AS
  SELECT
    s.id AS sighting_id,
    s.event_id,
    te->>'name' AS raw_name,
    trim(lower(te->>'name')) AS name_key,
    te->>'role' AS role,
    NULLIF(te->>'billing_position', '')::INT AS billing_position,
    s.extraction_confidence AS confidence
  FROM event_sightings s
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.raw_extraction->'talent', '[]'::jsonb)) te
  WHERE s.review_status != 'rejected'
    AND te->>'name' IS NOT NULL
    AND trim(te->>'name') != '';

  -- ── Step B: spelling buckets (whitespace/case collapsed, genuinely
  --    different spellings kept separate -- same as everywhere else
  --    this session). display_name keeps the highest-confidence
  --    original-cased reading. ──────────────────────────────────────
  CREATE TEMP TABLE _buckets ON COMMIT DROP AS
  SELECT
    name_key,
    (array_agg(raw_name ORDER BY confidence DESC))[1] AS display_name,
    SUM(confidence) AS bucket_weight,
    COUNT(*) AS bucket_n,
    array_agg(DISTINCT event_id) AS bucket_events
  FROM _raw_mentions
  GROUP BY name_key;

  -- ── Step C: similarity graph, both tiers combined (see header) ──────
  CREATE TEMP TABLE _edges ON COMMIT DROP AS
  WITH same_event_edges AS (
    SELECT a.name_key AS a_key, b.name_key AS b_key
    FROM _buckets a
    JOIN _buckets b ON b.name_key > a.name_key
    WHERE similarity(lower(a.display_name), lower(b.display_name)) >= 0.50
      AND a.bucket_events && b.bucket_events
      -- Concatenation guard: block if a third, distinct bucket sharing
      -- an event with a is a prefix/suffix run-on match against either
      -- a or b (real case: "Shelter Winston Hightowers" vs "Winston
      -- Hightower", where "Shelter" is independently a real co-billed
      -- act, not noise).
      AND NOT EXISTS (
        SELECT 1 FROM _buckets x
        WHERE x.name_key NOT IN (a.name_key, b.name_key)
          AND x.bucket_events && a.bucket_events
          AND length(x.display_name) >= 3
          AND (
            similarity(lower(x.display_name), lower(left(a.display_name, length(x.display_name)))) >= 0.70
            OR similarity(lower(x.display_name), lower(right(a.display_name, length(x.display_name)))) >= 0.70
            OR similarity(lower(x.display_name), lower(left(b.display_name, length(x.display_name)))) >= 0.70
            OR similarity(lower(x.display_name), lower(right(b.display_name, length(x.display_name)))) >= 0.70
          )
      )
  ),
  name_similarity_edges AS (
    SELECT a.name_key AS a_key, b.name_key AS b_key
    FROM _buckets a
    JOIN _buckets b ON b.name_key > a.name_key
    WHERE similarity(lower(a.display_name), lower(b.display_name)) >= 0.85
      AND NOT EXISTS (
        SELECT 1 FROM same_event_edges se WHERE se.a_key = a.name_key AND se.b_key = b.name_key
      )
  )
  SELECT a_key, b_key FROM same_event_edges
  UNION
  SELECT a_key, b_key FROM name_similarity_edges;

  -- ── Step D: connected components. Nodes are bucket name_key (TEXT),
  --    so MIN() works fine here -- the earlier MIN(uuid) bug was
  --    specific to clustering over talent.id directly; this function
  --    never does that. EVERY bucket is a node (not just ones with
  --    edges), so a unique, unambiguous name still forms its own
  --    singleton cluster and gets processed (picks up renames/
  --    resurrections even with no merge involved). ────────────────────
  CREATE TEMP TABLE _node_component ON COMMIT DROP AS
  WITH RECURSIVE
  bidirectional AS (
    SELECT a_key AS from_key, b_key AS to_key FROM _edges
    UNION ALL
    SELECT b_key, a_key FROM _edges
  ),
  reach(start_key, reached_key) AS (
    SELECT name_key, name_key FROM _buckets
    UNION
    SELECT r.start_key, e.to_key
    FROM reach r JOIN bidirectional e ON e.from_key = r.reached_key
  )
  SELECT start_key AS name_key, MIN(reached_key) AS cluster_id
  FROM reach GROUP BY start_key;

  CREATE TEMP TABLE _clusters ON COMMIT DROP AS
  SELECT
    nc.cluster_id,
    (array_agg(b.display_name ORDER BY b.bucket_weight DESC))[1] AS canonical_display_name
  FROM _node_component nc
  JOIN _buckets b ON b.name_key = nc.name_key
  GROUP BY nc.cluster_id;

  -- ── Resolve each cluster against current reality ─────────────────────
  FOR v_cluster IN SELECT * FROM _clusters LOOP

    -- Anchor = existing talent row (any is_active status) among this
    -- cluster's members holding the most CURRENT event_talent rows --
    -- minimizes relationship re-pointing. Ties: highest fresh bucket
    -- weight, then earliest created_at.
    SELECT t.id, t.name, t.is_active
    INTO v_anchor_id, v_anchor_current_name, v_anchor_is_active
    FROM talent t
    JOIN _node_component nc ON nc.cluster_id = v_cluster.cluster_id AND nc.name_key = t.canonical_name
    LEFT JOIN (
      SELECT et2.talent_id AS rel_talent_id, COUNT(*) AS n
      FROM event_talent et2
      GROUP BY et2.talent_id
    ) rel ON rel.rel_talent_id = t.id
    LEFT JOIN _buckets b ON b.name_key = t.canonical_name
    ORDER BY COALESCE(rel.n, 0) DESC, COALESCE(b.bucket_weight, 0) DESC, t.created_at ASC
    LIMIT 1;

    IF v_anchor_id IS NULL THEN
      -- No existing talent row matches any spelling in this cluster.
      IF NOT p_dry_run THEN
        INSERT INTO talent (name, canonical_name, last_active_at)
        VALUES (v_cluster.canonical_display_name, lower(trim(v_cluster.canonical_display_name)), now())
        RETURNING id INTO v_anchor_id;
      END IF;
      change_type := 'create';
      talent_id    := v_anchor_id;
      talent_name  := v_cluster.canonical_display_name;
      detail       := 'no existing talent row matched any spelling in this cluster';
      RETURN NEXT;
    ELSE
      IF v_anchor_current_name != v_cluster.canonical_display_name THEN
        change_type := 'rename';
        talent_id    := v_anchor_id;
        talent_name  := v_cluster.canonical_display_name;
        detail       := format('was "%s"', v_anchor_current_name);
        RETURN NEXT;
      END IF;

      IF NOT v_anchor_is_active THEN
        change_type := 'resurrect';
        talent_id    := v_anchor_id;
        talent_name  := v_cluster.canonical_display_name;
        detail       := 'was inactive; fresh clustering says this should be canonical';
        RETURN NEXT;
      END IF;

      IF NOT p_dry_run THEN
        UPDATE talent
        SET name = v_cluster.canonical_display_name,
            canonical_name = lower(trim(v_cluster.canonical_display_name)),
            is_active = true,
            merged_into_id = NULL, merged_at = NULL, merge_match_type = NULL,
            last_active_at = now()
        WHERE id = v_anchor_id;
      END IF;
    END IF;

    -- ── Ensure the anchor owns event_talent for every event this
    --    cluster's mentions ever touched, with best-confidence
    --    role/billing_position per event. ─────────────────────────────
    IF NOT p_dry_run THEN
      INSERT INTO event_talent (event_id, talent_id, role, billing_position)
      SELECT DISTINCT ON (rm.event_id)
        rm.event_id, v_anchor_id, rm.role, rm.billing_position
      FROM _raw_mentions rm
      JOIN _node_component nc ON nc.name_key = rm.name_key AND nc.cluster_id = v_cluster.cluster_id
      ORDER BY rm.event_id, rm.confidence DESC
      ON CONFLICT (event_id, talent_id) DO UPDATE
        SET role = EXCLUDED.role, billing_position = EXCLUDED.billing_position;
    ELSE
      FOR v_member IN
        SELECT DISTINCT ON (rm.event_id) rm.event_id, e.name AS event_name
        FROM _raw_mentions rm
        JOIN _node_component nc ON nc.name_key = rm.name_key AND nc.cluster_id = v_cluster.cluster_id
        JOIN events e ON e.id = rm.event_id
        WHERE NOT EXISTS (
          SELECT 1 FROM event_talent et
          WHERE et.event_id = rm.event_id AND et.talent_id = v_anchor_id
        )
        ORDER BY rm.event_id, rm.confidence DESC
      LOOP
        change_type := 'relink';
        talent_id    := v_anchor_id;
        talent_name  := v_cluster.canonical_display_name;
        detail       := format('event "%s" not yet linked to this talent', v_member.event_name);
        RETURN NEXT;
      END LOOP;
    END IF;

    -- ── Fold every other existing member of this cluster into the
    --    anchor. Relationships were already re-asserted onto the
    --    anchor above (correct regardless of member's own state), so
    --    this just discards member's now-redundant rows and records
    --    lineage. ─────────────────────────────────────────────────────
    FOR v_member IN
      SELECT t.id, t.name, t.is_active
      FROM talent t
      JOIN _node_component nc ON nc.cluster_id = v_cluster.cluster_id AND nc.name_key = t.canonical_name
      WHERE t.id != v_anchor_id
    LOOP
      IF v_member.is_active THEN
        IF NOT p_dry_run THEN
          DELETE FROM event_talent WHERE talent_id = v_member.id;
          UPDATE talent
          SET is_active = false, merged_into_id = v_anchor_id, merged_at = now(),
              merge_match_type = 'reconstruction'
          WHERE id = v_member.id;
        END IF;
        change_type := 'deactivate';
        talent_id    := v_member.id;
        talent_name  := v_member.name;
        detail       := format('folded into "%s"', v_cluster.canonical_display_name);
        RETURN NEXT;
      END IF;
    END LOOP;

  END LOOP;
END;
$$;