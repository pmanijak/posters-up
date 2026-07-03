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
--
-- ------------------------------------------------------------
-- SUSPICIOUS-NAME HEURISTIC (word count)
-- ------------------------------------------------------------
-- Neither the concatenation guard (which only fires when an edge is
-- being PROPOSED between two similar buckets) nor any corroboration-
-- based check can catch a name that's unanimously contaminated across
-- every sighting of a flyer -- there's no disagreement for a
-- corroboration check to notice. Real case: "Dick Rossetti Bulk Male"
-- (should be two acts from "Baby & The Nobodies / Dick Rossetti / Bulk
-- Male / Bassafras") was glued together the same way in every single
-- sighting, unlike "Shelter Winston Hightowers" where some sightings
-- split it correctly and some didn't -- there's no clean "Bulk Male"
-- bucket anywhere to cross-reference against. A poster that's
-- consistently torn, bent, or wind-blown produces a consistent
-- misread; the fix has to work without relying on disagreement
-- existing in the data at all.
--
-- talent_name_word_count_flag_threshold (config, default 4): any
-- cluster whose canonical display name has this many words or more is
-- flagged 'suspicious_name' and NOT created/renamed/resurrected,
-- regardless of tier or confidence. This will also flag some
-- legitimate long names ("Morgan and the Organ Donors," "Peter & the
-- Wolverines" both appear in real test data at 4-5 words) -- accepted
-- as the cost of a heuristic that has to work without corroboration.
-- ============================================================

INSERT INTO config (key, value, description) VALUES
  ('talent_name_word_count_flag_threshold', '4',
   'reconstruct_talent_from_sightings: talent names with this many
    words or more are flagged suspicious_name instead of being
    created/renamed/resurrected automatically -- catches adjacent
    flyer text glued together (event-format prefixes, run-on lineup
    entries) that no corroboration-based check can see, since the
    contamination is often consistent across every sighting.')
ON CONFLICT (key) DO NOTHING;


CREATE OR REPLACE FUNCTION reconstruct_talent_from_sightings(p_dry_run BOOLEAN DEFAULT true)
RETURNS TABLE (
  change_type TEXT,   -- 'create' | 'resurrect' | 'rename' | 'deactivate' | 'relink' | 'ambiguous_name' | 'suspicious_name'
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
  v_margin_fraction       FLOAT;
  v_final_name            TEXT;
  v_word_threshold        INT;
  v_word_count            INT;
BEGIN
  SELECT value::FLOAT INTO v_margin_fraction FROM config WHERE key = 'talent_merge_min_weight_margin';
  v_margin_fraction := COALESCE(v_margin_fraction, 0.10);

  SELECT value::INT INTO v_word_threshold FROM config WHERE key = 'talent_name_word_count_flag_threshold';
  v_word_threshold := COALESCE(v_word_threshold, 4);

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
  WITH ranked_buckets AS (
    SELECT
      nc.cluster_id,
      b.display_name,
      b.bucket_weight,
      ROW_NUMBER() OVER (PARTITION BY nc.cluster_id ORDER BY b.bucket_weight DESC) AS rnk
    FROM _node_component nc
    JOIN _buckets b ON b.name_key = nc.name_key
  )
  SELECT
    top.cluster_id,
    top.display_name AS canonical_display_name,
    top.bucket_weight AS top_weight,
    runner.bucket_weight AS runner_up_weight,
    -- Same signal (and same config knob) that gates automatic merge
    -- execution in run_talent_dedup_pass() also gates automatic NAME
    -- selection here: a near-tie in confidence between two candidate
    -- spellings shouldn't be resolved silently either direction (found
    -- via a real case -- "The Makinas" vs "The Makings" tied exactly at
    -- 0.72 each, and array_agg's ORDER BY has no tiebreaker for an exact
    -- tie, so which one "won" was arbitrary and happened to match the
    -- already-wrong current name, silently reporting nothing).
    (runner.bucket_weight IS NOT NULL
      AND runner.bucket_weight > top.bucket_weight * (1 - v_margin_fraction)) AS name_ambiguous
  FROM ranked_buckets top
  LEFT JOIN ranked_buckets runner ON runner.cluster_id = top.cluster_id AND runner.rnk = 2
  WHERE top.rnk = 1;

  -- ── Resolve each cluster against current reality ─────────────────────
  FOR v_cluster IN SELECT * FROM _clusters LOOP

    -- Computed once per cluster, independent of tie-detection or
    -- corroboration -- see header. A name this long gets flagged
    -- regardless of anything else being confident about it.
    v_word_count := array_length(regexp_split_to_array(trim(v_cluster.canonical_display_name), '\s+'), 1);

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

    IF v_anchor_id IS NULL AND v_word_count >= v_word_threshold THEN
      -- No existing row to fall back on, and the name itself looks
      -- like contaminated flyer text -- don't manufacture a new talent
      -- record from it. Nothing to fold/relink either (no existing
      -- rows are cluster members), so nothing else to do this run.
      change_type := 'suspicious_name';
      talent_id    := NULL;
      talent_name  := v_cluster.canonical_display_name;
      detail       := format(
        '%s words -- unusually long for a single performer name; often means adjacent flyer text (an event-format prefix, or two lineup entries) was combined. Not created, needs human review.',
        v_word_count
      );
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_anchor_id IS NULL THEN
      -- No existing talent row matches any spelling in this cluster.
      IF v_cluster.name_ambiguous THEN
        -- Top and runner-up candidate spellings are within
        -- talent_merge_min_weight_margin of each other -- creating a
        -- brand-new row under an arbitrarily-chosen spelling would be
        -- exactly the silent-coin-flip bug this guard exists to catch.
        -- Nothing to fold or relink either (no existing rows are
        -- cluster members), so there's nothing else to do this run.
        change_type := 'ambiguous_name';
        talent_id    := NULL;
        talent_name  := v_cluster.canonical_display_name;
        detail       := format(
          'no existing talent -- top candidate "%s" (weight %s) vs runner-up (weight %s) too close to call; not created, needs human review',
          v_cluster.canonical_display_name, round(v_cluster.top_weight::numeric, 2), round(v_cluster.runner_up_weight::numeric, 2)
        );
        RETURN NEXT;
        CONTINUE;
      END IF;

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
      IF v_word_count >= v_word_threshold THEN
        -- Real cases this catches: "Contra Dance – Eric Carl" and
        -- "Old Time Family Dance – Jesse Partridge" both resurrected
        -- as their own talent before this check existed -- an event-
        -- format prefix glued onto a real performer name, consistent
        -- across every sighting of each flyer, so no corroboration
        -- check could have caught either one. Skips resurrect/rename
        -- AND relink/deactivate below -- if the name itself might be
        -- two things stuck together, cluster membership built around
        -- it isn't trustworthy either until a human resolves it.
        change_type := 'suspicious_name';
        talent_id    := v_anchor_id;
        talent_name  := v_cluster.canonical_display_name;
        detail       := format(
          '%s words -- unusually long for a single performer name (current: "%s"). Often means adjacent flyer text was combined. Not renamed/resurrected, needs human review.',
          v_word_count, v_anchor_current_name
        );
        RETURN NEXT;
        CONTINUE;
      END IF;

      IF v_cluster.name_ambiguous THEN
        -- Same tie-detection, applied when an anchor already exists:
        -- don't rename it based on an arbitrary tiebreak. Real case
        -- this catches: "The Makinas" (current, wrong) vs "The
        -- Makings" (correct) tied exactly at weight 0.72 each --
        -- without this gate, array_agg's undefined tie order silently
        -- kept the wrong name with no signal anything was skipped.
        v_final_name := v_anchor_current_name;
        change_type  := 'ambiguous_name';
        talent_id    := v_anchor_id;
        talent_name  := v_cluster.canonical_display_name;
        detail       := format(
          'top candidate "%s" (weight %s) vs runner-up (weight %s) too close to call -- kept current name "%s", needs human review',
          v_cluster.canonical_display_name, round(v_cluster.top_weight::numeric, 2), round(v_cluster.runner_up_weight::numeric, 2), v_anchor_current_name
        );
        RETURN NEXT;
      ELSE
        v_final_name := v_cluster.canonical_display_name;
        IF v_anchor_current_name != v_final_name THEN
          change_type := 'rename';
          talent_id    := v_anchor_id;
          talent_name  := v_final_name;
          detail       := format('was "%s"', v_anchor_current_name);
          RETURN NEXT;
        END IF;
      END IF;

      IF NOT v_anchor_is_active THEN
        change_type := 'resurrect';
        talent_id    := v_anchor_id;
        talent_name  := v_final_name;
        detail       := 'was inactive; fresh clustering says this should be canonical';
        RETURN NEXT;
      END IF;

      IF NOT p_dry_run THEN
        UPDATE talent
        SET name = v_final_name,
            canonical_name = lower(trim(v_final_name)),
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