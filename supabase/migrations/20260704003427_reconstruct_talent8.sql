-- ============================================================
-- MIGRATION: wire resolved_real into reconstruct_talent_from_sightings()
-- ============================================================
--
-- When resolve-talent-name marks a candidate 'resolved_real', the
-- suspicious_name and ambiguous_name gates in reconstruct_talent_from_sightings()
-- should not block action on that cluster.
--
-- Safe wiring rule (from review of actual resolver output):
--   resolved_real  → skip gates, proceed, set event_talent.confirmed = true
--   resolved_split → no automatic action (status is a record, not a trigger)
--   resolved_uncertain → no automatic action
--
-- Gate on status only. verdict_confidence is intentionally NOT checked here --
-- the resolver calls wrong attributions 'high' as a matter of course; the
-- status column is the only reliable signal.
--
-- event_talent.confirmed is set to true for resolved_real clusters. The ON
-- CONFLICT clause never downgrades an existing confirmed = true row.
-- ============================================================

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
  v_content_word_count    INT;
  v_has_dash              BOOLEAN;
  v_is_resolved_real      BOOLEAN;
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

    -- Em-dash, en-dash, or a spaced hyphen ("Word - Word", not a
    -- compound like "A-Ron") is a near-certain concatenation signal on
    -- its own -- every real "Contra Dance – X" / "Old Time Family
    -- Dance – X" case had one, and essentially no real single
    -- performer name does. Triggers suspicious_name independent of
    -- word count.
    v_has_dash := v_cluster.canonical_display_name ~ '[–—]' OR v_cluster.canonical_display_name ~ ' - ';

    -- Triage aid, NOT a separate trigger: "&"/"and"/"the" are extremely
    -- common inside real band names (Shannon and the Clams, Morgan &
    -- The Organ Donors, Baby & The Nobodies, The Devil in Miss Jones --
    -- all confirmed real from actual queue data), so their presence
    -- can't safely EXEMPT a name from the word-count check. Doing so
    -- would silently un-flag "Owl & The Pussycat Slippers" (a real
    -- concatenation -- "Slippers" is independently a distinct act on
    -- the same lineup; 5 words total, only 3 content words). Surfaced
    -- in `detail` instead, so the queue can be triaged: "5 words, 2
    -- content" is far more likely a real "X & the Y" band than "5
    -- words, 5 content."
    v_content_word_count := (
      SELECT COUNT(*)
      FROM unnest(regexp_split_to_array(trim(v_cluster.canonical_display_name), '\s+')) AS w
      WHERE lower(w) NOT IN ('&', 'and', 'the')
    );

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

    -- Check whether any name in this cluster has been verified real by
    -- resolve-talent-name. When true, the suspicious_name and ambiguous_name
    -- gates below are bypassed -- the AI web search already confirmed this
    -- is a real entity, so structural heuristics should not block action.
    -- Gate on status = 'resolved_real' only. verdict_confidence is not
    -- checked here -- it is unreliable (the resolver calls wrong attributions
    -- 'high' as normal behavior, not an edge case).
    SELECT EXISTS (
      SELECT 1 FROM talent_name_reviews tnr
      JOIN _node_component nc ON nc.cluster_id = v_cluster.cluster_id
        AND nc.name_key = tnr.name_key
      WHERE tnr.status = 'resolved_real'
    ) INTO v_is_resolved_real;

    IF v_anchor_id IS NULL AND (v_word_count >= v_word_threshold OR v_has_dash) AND NOT v_is_resolved_real THEN
      -- No existing row to fall back on, and the name itself looks
      -- like contaminated flyer text -- don't manufacture a new talent
      -- record from it. Nothing to fold/relink either (no existing
      -- rows are cluster members), so nothing else to do this run.
      change_type := 'suspicious_name';
      talent_id    := NULL;
      talent_name  := v_cluster.canonical_display_name;
      detail       := format(
        '%s words (%s excluding &/and/the)%s -- often means adjacent flyer text (an event-format prefix, or two lineup entries) was combined. Not created, needs human review.',
        v_word_count, v_content_word_count,
        CASE WHEN v_has_dash THEN ', contains a dash' ELSE '' END
      );
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_anchor_id IS NULL THEN
      -- No existing talent row matches any spelling in this cluster.
      IF v_cluster.name_ambiguous AND NOT v_is_resolved_real THEN
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
      IF (v_word_count >= v_word_threshold OR v_has_dash) AND NOT v_is_resolved_real THEN
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
          '%s words (%s excluding &/and/the)%s (current: "%s"). Often means adjacent flyer text was combined. Not renamed/resurrected, needs human review.',
          v_word_count, v_content_word_count,
          CASE WHEN v_has_dash THEN ', contains a dash' ELSE '' END,
          v_anchor_current_name
        );
        RETURN NEXT;
        CONTINUE;
      END IF;

      IF v_cluster.name_ambiguous AND NOT v_is_resolved_real THEN
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
    --    role/billing_position per event. confirmed = true when this
    --    cluster is backed by a resolved_real verdict -- never
    --    downgrade an existing confirmed = true row. ──────────────────
    IF NOT p_dry_run THEN
      INSERT INTO event_talent (event_id, talent_id, role, billing_position, confirmed)
      SELECT DISTINCT ON (rm.event_id)
        rm.event_id, v_anchor_id, rm.role, rm.billing_position,
        v_is_resolved_real
      FROM _raw_mentions rm
      JOIN _node_component nc ON nc.name_key = rm.name_key AND nc.cluster_id = v_cluster.cluster_id
      ORDER BY rm.event_id, rm.confidence DESC
      ON CONFLICT ON CONSTRAINT event_talent_event_id_talent_id_key DO UPDATE
        SET role             = EXCLUDED.role,
            billing_position = EXCLUDED.billing_position,
            confirmed        = CASE WHEN EXCLUDED.confirmed THEN true ELSE event_talent.confirmed END;
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
          DELETE FROM event_talent et WHERE et.talent_id = v_member.id;
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