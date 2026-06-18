-- ============================================================
-- Bulk Dedup Pass
-- Applies on top of migration_dedup_v2.sql.
--
-- Adds two functions:
--
--   merge_events(canonical_id, duplicate_id)
--     Merges one duplicate into a canonical record:
--     re-points all FK references, union-merges array fields,
--     fills null scalars from the duplicate, deactivates the
--     duplicate, recomputes confidence.
--
--   run_dedup_pass(p_dry_run BOOLEAN DEFAULT true)
--     Scans all active events for candidate duplicate pairs
--     using the same three tiers as find_event_match(), then
--     calls merge_events() on each pair.
--     Defaults to dry run — returns what would be merged
--     without touching the DB. Pass false to run for real.
--
-- Usage:
--   SELECT * FROM run_dedup_pass();           -- dry run (safe to run anytime)
--   SELECT * FROM run_dedup_pass(false);      -- live merge
--
-- Safe to run multiple times — merge_events() skips any event
-- that is no longer active, so re-runs are idempotent.
-- ============================================================

BEGIN;


-- ============================================================
-- MERGE EVENTS
-- Merges p_duplicate_id into p_canonical_id.
-- Canonical = the record you want to keep.
-- Duplicate = the record to deactivate.
--
-- What happens:
--   1. event_sightings   re-pointed to canonical
--   2. board_flyers      upserted to canonical (timestamps merged)
--   3. event_verifications re-pointed to canonical
--   4. event_talent      non-conflicting rows moved; canonical wins conflicts
--   5. event_reports     re-pointed to canonical
--   6. events fields     array fields union-merged; scalar nulls filled
--   7. duplicate         deactivated (is_active = false)
--   8. confidence        recomputed on canonical
-- ============================================================

CREATE OR REPLACE FUNCTION merge_events(
  p_canonical_id UUID,
  p_duplicate_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_dup events%ROWTYPE;
BEGIN

  -- Guard: skip if either record is gone or already inactive.
  -- This makes the function safe to call multiple times and handles
  -- the case where A-B and A-C are both pairs: processing A-B first
  -- deactivates B; if B-C is also a pair, the B side is already gone.
  IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_canonical_id AND is_active = true) THEN
    RAISE NOTICE 'merge_events: canonical % not active, skipping', p_canonical_id;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_duplicate_id AND is_active = true) THEN
    RAISE NOTICE 'merge_events: duplicate % not active, skipping', p_duplicate_id;
    RETURN;
  END IF;

  SELECT * INTO v_dup FROM events WHERE id = p_duplicate_id;

  -- 1. Sightings: straight re-point, no unique constraint issues.
  UPDATE event_sightings
  SET event_id = p_canonical_id
  WHERE event_id = p_duplicate_id;

  -- 2. Board flyers: UNIQUE(board_id, event_id) means we need an upsert.
  --    If both events were on the same board, merge the row:
  --    - first_seen_at = earliest of the two
  --    - last_seen_at  = latest of the two
  --    - is_active     = true if either was active
  --    - removed_at    = null if now active, else latest removal time
  INSERT INTO board_flyers
    (board_id, event_id, first_seen_at, last_seen_at, is_active, removed_at, created_at)
  SELECT
    bf.board_id,
    p_canonical_id,
    bf.first_seen_at,
    bf.last_seen_at,
    bf.is_active,
    bf.removed_at,
    bf.created_at
  FROM board_flyers bf
  WHERE bf.event_id = p_duplicate_id
  ON CONFLICT (board_id, event_id) DO UPDATE SET
    first_seen_at = LEAST(board_flyers.first_seen_at, EXCLUDED.first_seen_at),
    last_seen_at  = GREATEST(board_flyers.last_seen_at, EXCLUDED.last_seen_at),
    is_active     = board_flyers.is_active OR EXCLUDED.is_active,
    removed_at    = CASE
                      WHEN board_flyers.is_active OR EXCLUDED.is_active THEN NULL
                      ELSE GREATEST(board_flyers.removed_at, EXCLUDED.removed_at)
                    END;

  DELETE FROM board_flyers WHERE event_id = p_duplicate_id;

  -- 3. Verifications: straight re-point.
  UPDATE event_verifications
  SET event_id = p_canonical_id
  WHERE event_id = p_duplicate_id;

  -- 4. Talent: move non-conflicting rows; canonical wins on conflict.
  --    UNIQUE(event_id, talent_id) means we can't have two rows for
  --    the same talent on the canonical event — keep canonical's row.
  INSERT INTO event_talent (event_id, talent_id, role, billing_position, created_at)
  SELECT p_canonical_id, talent_id, role, billing_position, created_at
  FROM event_talent
  WHERE event_id = p_duplicate_id
  ON CONFLICT (event_id, talent_id) DO NOTHING;

  DELETE FROM event_talent WHERE event_id = p_duplicate_id;

  -- 5. Reports: straight re-point.
  UPDATE event_reports
  SET event_id = p_canonical_id
  WHERE event_id = p_duplicate_id;

  -- 6. Merge fields onto canonical.
  --    Arrays: union (deduplicated).
  --    Scalars: fill nulls on canonical from duplicate (COALESCE).
  --    Timestamps: widen the observation window.
  --    enrichment_attempted_at: reset to null so enrich re-runs with
  --    the merged sightings as context.
  UPDATE events SET
    -- Array fields: union merge
    tags             = ARRAY(SELECT DISTINCT unnest(
                         COALESCE(tags, '{}') || COALESCE(v_dup.tags, '{}')
                       )),
    accessibility    = ARRAY(SELECT DISTINCT unnest(
                         COALESCE(accessibility, '{}') || COALESCE(v_dup.accessibility, '{}')
                       )),
    -- Scalar fields: keep canonical's value; fill nulls from duplicate
    event_category   = COALESCE(event_category,   v_dup.event_category),
    age_restriction  = COALESCE(age_restriction,   v_dup.age_restriction),
    language         = COALESCE(language,           v_dup.language),
    is_outdoor       = COALESCE(is_outdoor,         v_dup.is_outdoor),
    masks_required   = COALESCE(masks_required,     v_dup.masks_required),
    price_raw        = COALESCE(price_raw,           v_dup.price_raw),
    is_free          = COALESCE(is_free,             v_dup.is_free),
    event_url        = COALESCE(event_url,           v_dup.event_url),
    location_address = COALESCE(location_address,   v_dup.location_address),
    time_start       = COALESCE(time_start,         v_dup.time_start),
    time_end         = COALESCE(time_end,           v_dup.time_end),
    description      = COALESCE(description,         v_dup.description),
    contact          = COALESCE(contact,             v_dup.contact),
    rsvp_url         = COALESCE(rsvp_url,           v_dup.rsvp_url),
    -- Widen the observation window
    first_sighted_at = LEAST(first_sighted_at,     v_dup.first_sighted_at),
    last_sighted_at  = GREATEST(last_sighted_at,   v_dup.last_sighted_at),
    -- Re-queue for enrichment with the richer merged data
    enrichment_attempted_at = NULL,
    updated_at       = now()
  WHERE id = p_canonical_id;

  -- 7. Deactivate duplicate.
  UPDATE events
  SET is_active = false, updated_at = now()
  WHERE id = p_duplicate_id;

  -- 8. Recompute confidence on canonical.
  --    Now has merged sightings + verifications so the score reflects reality.
  PERFORM compute_event_confidence(p_canonical_id);

END;
$$;


-- ============================================================
-- RUN DEDUP PASS
-- Finds all candidate duplicate pairs across active events and
-- either returns them (dry run) or merges them (live run).
--
-- Canonical = older record (lower created_at). Rationale: the
-- first sighting is usually the most complete extraction, and
-- merge_events() fills canonical's nulls from the duplicate
-- anyway, so data loss is minimal regardless of which is kept.
--
-- Three match tiers (same logic as find_event_match, batch form):
--
--   'url'           — identical non-null event_url
--   'talent_anchor' — same headliner + date ≤1 day + location sim ≥0.60
--   'fuzzy'         — normalized name sim ≥0.65 + date ≤1 day
--                     + location sim ≥0.65 (or ≥0.90 with no location)
--
-- Pairs are collected before any merges run, so the pass is
-- stable even when A-B and A-C are both pairs (B and C both
-- merge into A; if B-C is also a pair, merge_events skips it
-- gracefully since B is already inactive).
--
-- Performance note: the fuzzy tier does a pairwise name similarity
-- scan. On a small DB (hundreds of events) this is fast. If the
-- event count grows into the thousands, add a date-range partition:
-- WHERE ABS(a.date_start - b.date_start) <= 1 will limit the
-- cross-product significantly when both events have specific dates.
-- ============================================================

CREATE OR REPLACE FUNCTION run_dedup_pass(p_dry_run BOOLEAN DEFAULT true)
RETURNS TABLE (
  canonical_id   UUID,
  canonical_name TEXT,
  duplicate_id   UUID,
  duplicate_name TEXT,
  match_type     TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_pair RECORD;
BEGIN

  -- Collect all candidate pairs up front.
  -- ON COMMIT DROP means the temp table is cleaned up automatically.
  CREATE TEMP TABLE _dedup_pairs (
    canonical_id UUID,
    duplicate_id UUID,
    match_type   TEXT
  ) ON COMMIT DROP;


  -- -------------------------------------------------------
  -- Tier 1: URL hard match
  -- -------------------------------------------------------
  INSERT INTO _dedup_pairs
  SELECT
    CASE WHEN a.created_at <= b.created_at THEN a.id ELSE b.id END AS canonical_id,
    CASE WHEN a.created_at <= b.created_at THEN b.id ELSE a.id END AS duplicate_id,
    'url' AS match_type
  FROM events a
  JOIN events b ON b.event_url = a.event_url
               AND b.id > a.id        -- prevent A-B and B-A both appearing
               AND b.is_active = true
  WHERE a.is_active = true
    AND a.event_url IS NOT NULL;


  -- -------------------------------------------------------
  -- Tier 1.5: Talent anchor match
  -- Uses a LATERAL subquery to get the top-billed act per event
  -- (lowest billing_position; any talent if all positions are null).
  -- Excludes pairs already captured by the URL tier.
  -- -------------------------------------------------------
  INSERT INTO _dedup_pairs
  SELECT
    CASE WHEN a.created_at <= b.created_at THEN a.id ELSE b.id END,
    CASE WHEN a.created_at <= b.created_at THEN b.id ELSE a.id END,
    'talent_anchor'
  FROM events a
  JOIN events b ON b.id > a.id AND b.is_active = true
  -- Top-billed act for event a
  JOIN LATERAL (
    SELECT t.canonical_name
    FROM event_talent et
    JOIN talent t ON t.id = et.talent_id
    WHERE et.event_id = a.id
    ORDER BY et.billing_position ASC NULLS LAST
    LIMIT 1
  ) ta ON true
  -- Top-billed act for event b
  JOIN LATERAL (
    SELECT t.canonical_name
    FROM event_talent et
    JOIN talent t ON t.id = et.talent_id
    WHERE et.event_id = b.id
    ORDER BY et.billing_position ASC NULLS LAST
    LIMIT 1
  ) tb ON true
  WHERE a.is_active = true
    AND similarity(lower(ta.canonical_name), lower(tb.canonical_name)) >= 0.80
    AND (a.date_start IS NULL OR b.date_start IS NULL
         OR ABS(a.date_start - b.date_start) <= 1)
    AND (a.location_name IS NULL OR b.location_name IS NULL
         OR similarity(lower(a.location_name), lower(b.location_name)) >= 0.60)
    -- Skip pairs already captured by URL tier
    AND NOT EXISTS (
      SELECT 1 FROM _dedup_pairs p
      WHERE (p.canonical_id = a.id OR p.canonical_id = b.id)
        AND (p.duplicate_id = a.id OR p.duplicate_id = b.id)
    );


  -- -------------------------------------------------------
  -- Tier 2: Fuzzy name match
  -- Normalized name similarity + date + location.
  -- Excludes pairs already captured above.
  -- -------------------------------------------------------
  INSERT INTO _dedup_pairs
  SELECT
    CASE WHEN a.created_at <= b.created_at THEN a.id ELSE b.id END,
    CASE WHEN a.created_at <= b.created_at THEN b.id ELSE a.id END,
    'fuzzy'
  FROM events a
  JOIN events b ON b.id > a.id AND b.is_active = true
  WHERE a.is_active = true
    -- Name similarity threshold (same as find_event_match Tier 2)
    AND similarity(normalize_event_name(a.name), normalize_event_name(b.name)) >= 0.65
    -- Date must agree (or be absent on one side)
    AND (a.date_start IS NULL OR b.date_start IS NULL
         OR ABS(a.date_start - b.date_start) <= 1)
    -- Location confirmation required, or stronger name alone
    AND (
      (a.location_name IS NOT NULL AND b.location_name IS NOT NULL
       AND similarity(lower(a.location_name), lower(b.location_name)) >= 0.65)
      OR
      ((a.location_name IS NULL OR b.location_name IS NULL)
       AND similarity(normalize_event_name(a.name), normalize_event_name(b.name)) >= 0.90)
    )
    -- Skip pairs already captured above
    AND NOT EXISTS (
      SELECT 1 FROM _dedup_pairs p
      WHERE (p.canonical_id = a.id OR p.canonical_id = b.id)
        AND (p.duplicate_id = a.id OR p.duplicate_id = b.id)
    );


  -- -------------------------------------------------------
  -- Emit rows and (if live) call merge_events on each pair.
  -- -------------------------------------------------------
  FOR v_pair IN
    SELECT
      dp.canonical_id,
      ec.name AS canonical_name,
      dp.duplicate_id,
      ed.name AS duplicate_name,
      dp.match_type
    FROM _dedup_pairs dp
    JOIN events ec ON ec.id = dp.canonical_id
    JOIN events ed ON ed.id = dp.duplicate_id
    -- Process URL matches first, then talent, then fuzzy.
    ORDER BY dp.match_type, ec.name
  LOOP
    canonical_id   := v_pair.canonical_id;
    canonical_name := v_pair.canonical_name;
    duplicate_id   := v_pair.duplicate_id;
    duplicate_name := v_pair.duplicate_name;
    match_type     := v_pair.match_type;

    IF NOT p_dry_run THEN
      PERFORM merge_events(v_pair.canonical_id, v_pair.duplicate_id);
    END IF;

    RETURN NEXT;
  END LOOP;

END;
$$;

COMMIT;


-- ============================================================
-- HOW TO USE
--
-- 1. Dry run first — see what would be merged:
--
--    SELECT * FROM run_dedup_pass();
--
-- 2. Review the output. Check any 'fuzzy' matches carefully —
--    those are the ones most likely to be wrong. URL and
--    talent_anchor matches are almost always correct.
--
-- 3. If you spot a pair that shouldn't be merged, you can
--    exclude it by deactivating one side temporarily, running
--    the live pass, then reactivating. Or just merge manually
--    by calling merge_events() on the pairs you trust.
--
-- 4. Live run:
--
--    SELECT * FROM run_dedup_pass(false);
--
-- 5. To merge a specific pair directly (e.g. the Landroid case):
--
--    SELECT merge_events(
--      '73f6c12e-e23d-43d5-89fd-487e85b3b74c',  -- canonical (keep)
--      '7d81e6ac-ea7d-4771-849e-03eaaca762d3'   -- duplicate (deactivate)
--    );
--
-- 6. For a nightly cron job, schedule via pg_cron:
--
--    SELECT cron.schedule(
--      'nightly-dedup',
--      '0 3 * * *',   -- 3am nightly
--      $$ SELECT run_dedup_pass(false) $$
--    );
-- ============================================================