-- ============================================================
-- Migration: never auto-merge events with differing date_type
--
-- Supersedes the previous draft (migration_date_type_priority_merge_
-- lineage.sql), which had run_dedup_pass() let a 'recurring' event
-- always win canonical status over a 'specific' one, then auto-merge.
-- That fixed the data-loss vector (a recurring event's recurrence_rule
-- surviving) but not the actual question underneath it: a 'recurring'
-- listing ("Wild Child -- Sunday Events", weekly) and a 'specific'
-- flyer ("Wild Child -- Sunday June 7th Event") aren't necessarily the
-- same real-world thing. The specific flyer could be one instance of
-- the known series, or it could be a distinct one-off event that
-- happens to land on a Sunday at a venue that also runs a regular
-- Sunday night. Name/venue/date similarity can't tell those apart --
-- unlike e.g. the McCoy's Tavern case, where overlapping band names
-- across independent misreads gave positive evidence of the same
-- flyer.
--
-- Fix: talent_anchor, location_anchor, and fuzzy tiers (all inferred-
-- similarity based) no longer auto-merge a pair when the two events
-- have different date_type -- they're left as separate events, by
-- design, not queued for anything. The pair is still detected and
-- returned (with date_type_mismatch = true) purely as informational
-- metadata for anyone inspecting run_dedup_pass() output; there's no
-- review workflow this feeds into, and none is implied. merge_events()
-- can still be called manually on a specific pair if someone spots one
-- that's genuinely the same flyer. The url tier is unaffected -- a
-- literal shared event_url is authoritative regardless of date_type,
-- so those still auto-merge as before.
--
-- event_date_type_priority() is kept from the previous draft: it no
-- longer drives an auto-merge decision, but it's still useful for
-- picking which side displays as "canonical" in the returned rows
-- when a pair IS eligible to auto-merge (both sides sharing a
-- date_type, or the url tier).
--
-- Merge lineage (merged_into_id / merged_at / merge_match_type on
-- events, mirroring talent) is unchanged from the previous draft.
-- ============================================================

-- ------------------------------------------------------------
-- EVENT MERGE LINEAGE
-- Mirrors talent.merged_into_id / merged_at / merge_match_type.
-- Unchanged from the previous draft -- included here so this file is
-- a complete, standalone migration rather than a diff against it.
-- ------------------------------------------------------------
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS merged_into_id   UUID REFERENCES events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merged_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS merge_match_type TEXT;  -- 'url', 'talent_anchor', 'location_anchor', 'fuzzy'

CREATE INDEX IF NOT EXISTS idx_events_merged_into ON events(merged_into_id) WHERE merged_into_id IS NOT NULL;


-- ------------------------------------------------------------
-- EVENT DATE TYPE PRIORITY
-- Higher = more information encoded / harder to reconstruct if lost.
-- No longer used to justify auto-merging across date_types (see
-- migration note above) -- kept only to pick which side of an
-- eligible-to-merge pair (matching date_type, or the url tier)
-- displays as canonical.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION event_date_type_priority(p_date_type TEXT)
RETURNS INT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE p_date_type
    WHEN 'recurring'   THEN 4
    WHEN 'specific'    THEN 3
    WHEN 'approximate' THEN 2
    WHEN 'unknown'     THEN 1
    ELSE 0
  END;
$$;


-- ------------------------------------------------------------
-- MERGE EVENTS
-- Unchanged from the previous draft: accepts p_match_type and writes
-- merge lineage on the duplicate (step 7), mirroring merge_talent().
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION merge_events(
  p_canonical_id UUID,
  p_duplicate_id UUID,
  p_match_type   TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_dup events%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_canonical_id AND is_active = true) THEN
    RAISE NOTICE 'merge_events: canonical % not active, skipping', p_canonical_id;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_duplicate_id AND is_active = true) THEN
    RAISE NOTICE 'merge_events: duplicate % not active, skipping', p_duplicate_id;
    RETURN;
  END IF;

  SELECT * INTO v_dup FROM events WHERE id = p_duplicate_id;

  -- 1. Sightings
  UPDATE event_sightings SET event_id = p_canonical_id WHERE event_id = p_duplicate_id;

  -- 2. Board flyers (upsert — UNIQUE(board_id, event_id))
  INSERT INTO board_flyers (board_id, event_id, first_seen_at, last_seen_at, is_active, removed_at, created_at)
  SELECT bf.board_id, p_canonical_id, bf.first_seen_at, bf.last_seen_at, bf.is_active, bf.removed_at, bf.created_at
  FROM board_flyers bf WHERE bf.event_id = p_duplicate_id
  ON CONFLICT (board_id, event_id) DO UPDATE SET
    first_seen_at = LEAST(board_flyers.first_seen_at, EXCLUDED.first_seen_at),
    last_seen_at  = GREATEST(board_flyers.last_seen_at, EXCLUDED.last_seen_at),
    is_active     = board_flyers.is_active OR EXCLUDED.is_active,
    removed_at    = CASE
                      WHEN board_flyers.is_active OR EXCLUDED.is_active THEN NULL
                      ELSE GREATEST(board_flyers.removed_at, EXCLUDED.removed_at)
                    END;

  DELETE FROM board_flyers WHERE event_id = p_duplicate_id;

  -- 3. Verifications (delete conflicts, then re-point remainder — see
  --    ARCHITECTURE.md #6: source_url_normalized is a generated column
  --    and can't be inserted/updated directly, and a plain UPDATE would
  --    violate uq_event_verifications_normalized if both events already
  --    verified the same URL)
  DELETE FROM event_verifications
  WHERE event_id = p_duplicate_id
    AND source_url_normalized IN (
      SELECT source_url_normalized FROM event_verifications WHERE event_id = p_canonical_id
    );

  UPDATE event_verifications SET event_id = p_canonical_id WHERE event_id = p_duplicate_id;

  -- 4. Talent (canonical wins on conflict)
  INSERT INTO event_talent (event_id, talent_id, role, billing_position, created_at)
  SELECT p_canonical_id, talent_id, role, billing_position, created_at
  FROM event_talent WHERE event_id = p_duplicate_id
  ON CONFLICT (event_id, talent_id) DO NOTHING;

  DELETE FROM event_talent WHERE event_id = p_duplicate_id;

  -- 5. Reports
  UPDATE event_reports SET event_id = p_canonical_id WHERE event_id = p_duplicate_id;

  -- 6. Merge fields onto canonical
  -- date_type / date_start / date_end / recurrence_rule / date_raw are
  -- deliberately NOT in this list -- the canonical's own date info
  -- always wins outright, never backfilled from the duplicate.
  UPDATE events SET
    tags             = ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}') || COALESCE(v_dup.tags, '{}'))),
    accessibility    = ARRAY(SELECT DISTINCT unnest(COALESCE(accessibility, '{}') || COALESCE(v_dup.accessibility, '{}'))),
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
    first_sighted_at = LEAST(first_sighted_at,     v_dup.first_sighted_at),
    last_sighted_at  = GREATEST(last_sighted_at,   v_dup.last_sighted_at),
    enrichment_attempted_at = NULL,   -- re-queue with merged data
    updated_at       = now()
  WHERE id = p_canonical_id;

  -- 7. Deactivate duplicate, recording merge lineage (mirrors
  --    merge_talent()'s merged_into_id / merged_at / merge_match_type).
  UPDATE events SET
    is_active        = false,
    merged_into_id   = p_canonical_id,
    merged_at        = now(),
    merge_match_type = p_match_type,
    updated_at       = now()
  WHERE id = p_duplicate_id;

  -- 8. Recompute confidence
  PERFORM compute_event_confidence(p_canonical_id);
END;
$$;


-- ------------------------------------------------------------
-- RUN DEDUP PASS
-- Adds a date_type_mismatch output column. talent_anchor, location_anchor,
-- and fuzzy tiers set date_type_mismatch = true when the pair's date_type
-- differs -- these pairs are still detected and returned, but skipped
-- in the merge loop below regardless of p_dry_run, since an inferred-
-- similarity match across date_types isn't reliable enough to auto-
-- merge (see migration note above). The url tier is unaffected --
-- a literal shared event_url auto-merges as before, date_type_mismatch
-- always false there.
--
-- Canonical/duplicate selection still prefers the higher
-- event_date_type_priority() side when a pair does merge (matching
-- date_type pairs, or url-tier pairs) -- this only affects which side
-- displays as canonical, not whether the pair merges.
-- ------------------------------------------------------------
-- Postgres refuses to CREATE OR REPLACE a function when its RETURNS
-- TABLE column list changes (only the body may change in place) --
-- date_type_mismatch is a new output column, so the old signature has
-- to be dropped first.
DROP FUNCTION IF EXISTS run_dedup_pass(BOOLEAN);

CREATE OR REPLACE FUNCTION run_dedup_pass(p_dry_run BOOLEAN DEFAULT true)
RETURNS TABLE (
  canonical_id   UUID,
  canonical_name TEXT,
  duplicate_id   UUID,
  duplicate_name TEXT,
  match_type         TEXT,
  date_type_mismatch BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_pair RECORD;
BEGIN
  CREATE TEMP TABLE _dedup_pairs (
    canonical_id UUID,
    duplicate_id UUID,
    match_type   TEXT,
    date_type_mismatch BOOLEAN
  ) ON COMMIT DROP;

  -- Tier 1: URL hard match — a shared event_url is authoritative
  -- regardless of date_type, so this tier never sets date_type_mismatch.
  INSERT INTO _dedup_pairs
  SELECT
    CASE
      WHEN event_date_type_priority(a.date_type) > event_date_type_priority(b.date_type) THEN a.id
      WHEN event_date_type_priority(a.date_type) < event_date_type_priority(b.date_type) THEN b.id
      WHEN a.created_at <= b.created_at THEN a.id
      ELSE b.id
    END,
    CASE
      WHEN event_date_type_priority(a.date_type) > event_date_type_priority(b.date_type) THEN b.id
      WHEN event_date_type_priority(a.date_type) < event_date_type_priority(b.date_type) THEN a.id
      WHEN a.created_at <= b.created_at THEN b.id
      ELSE a.id
    END,
    'url',
    false
  FROM events a
  JOIN events b ON b.event_url = a.event_url AND b.id > a.id AND b.is_active = true
  WHERE a.is_active = true AND a.event_url IS NOT NULL;

  -- Tier 1.5: Talent anchor match
  INSERT INTO _dedup_pairs
  SELECT
    CASE
      WHEN event_date_type_priority(a.date_type) > event_date_type_priority(b.date_type) THEN a.id
      WHEN event_date_type_priority(a.date_type) < event_date_type_priority(b.date_type) THEN b.id
      WHEN a.created_at <= b.created_at THEN a.id
      ELSE b.id
    END,
    CASE
      WHEN event_date_type_priority(a.date_type) > event_date_type_priority(b.date_type) THEN b.id
      WHEN event_date_type_priority(a.date_type) < event_date_type_priority(b.date_type) THEN a.id
      WHEN a.created_at <= b.created_at THEN b.id
      ELSE a.id
    END,
    'talent_anchor',
    a.date_type IS DISTINCT FROM b.date_type
  FROM events a
  JOIN events b ON b.id > a.id AND b.is_active = true
  JOIN LATERAL (
    SELECT t.canonical_name FROM event_talent et JOIN talent t ON t.id = et.talent_id
    WHERE et.event_id = a.id ORDER BY et.billing_position ASC NULLS LAST LIMIT 1
  ) ta ON true
  JOIN LATERAL (
    SELECT t.canonical_name FROM event_talent et JOIN talent t ON t.id = et.talent_id
    WHERE et.event_id = b.id ORDER BY et.billing_position ASC NULLS LAST LIMIT 1
  ) tb ON true
  WHERE a.is_active = true
    AND similarity(lower(ta.canonical_name), lower(tb.canonical_name)) >= 0.80
    AND (a.date_start IS NULL OR b.date_start IS NULL OR ABS(a.date_start - b.date_start) <= 1)
    AND (a.location_name IS NULL OR b.location_name IS NULL
         OR similarity(normalize_location_name(a.location_name), normalize_location_name(b.location_name)) >= 0.60
         OR normalize_location_name(a.location_name) LIKE '%' || normalize_location_name(b.location_name) || '%'
         OR normalize_location_name(b.location_name) LIKE '%' || normalize_location_name(a.location_name) || '%')
    -- Sanity check: event names must be at least loosely related.
    -- Prevents a shared billing_position=1 act from merging events that are
    -- clearly different (e.g. "One Day Closer to Doom" vs "Storm Boy / 30 Coffin...").
    AND similarity(normalize_event_name(a.name), normalize_event_name(b.name)) >= 0.30
    AND NOT EXISTS (
      SELECT 1 FROM _dedup_pairs p
      WHERE (p.canonical_id = a.id OR p.canonical_id = b.id)
        AND (p.duplicate_id = a.id OR p.duplicate_id = b.id)
    );

  -- Tier 1.7: Location anchor match
  -- Same exact date + high location similarity → low name bar.
  -- Catches OCR failures and wildly different poster readings of the same event.
  -- The 0.20 name floor prevents two different events at the same venue on the
  -- same day (e.g. morning storytime + evening concert) from merging.
  -- Note: both sides require date_start IS NOT NULL here, so a 'recurring'
  -- event (date_start always NULL) can never reach this tier — the
  -- date_type IS DISTINCT FROM check is included anyway for consistency
  -- and in case that invariant ever changes.
  INSERT INTO _dedup_pairs
  SELECT
    CASE
      WHEN event_date_type_priority(a.date_type) > event_date_type_priority(b.date_type) THEN a.id
      WHEN event_date_type_priority(a.date_type) < event_date_type_priority(b.date_type) THEN b.id
      WHEN a.created_at <= b.created_at THEN a.id
      ELSE b.id
    END,
    CASE
      WHEN event_date_type_priority(a.date_type) > event_date_type_priority(b.date_type) THEN b.id
      WHEN event_date_type_priority(a.date_type) < event_date_type_priority(b.date_type) THEN a.id
      WHEN a.created_at <= b.created_at THEN b.id
      ELSE a.id
    END,
    'location_anchor',
    a.date_type IS DISTINCT FROM b.date_type
  FROM events a
  JOIN events b ON b.id > a.id AND b.is_active = true
  WHERE a.is_active = true
    AND a.date_start IS NOT NULL
    AND b.date_start IS NOT NULL
    AND a.date_start = b.date_start
    AND a.location_name IS NOT NULL
    AND b.location_name IS NOT NULL
    AND (
      similarity(normalize_location_name(a.location_name), normalize_location_name(b.location_name)) >= 0.85
      OR normalize_location_name(a.location_name) LIKE '%' || normalize_location_name(b.location_name) || '%'
      OR normalize_location_name(b.location_name) LIKE '%' || normalize_location_name(a.location_name) || '%'
    )
    AND similarity(normalize_event_name(a.name), normalize_event_name(b.name)) >= 0.20
    AND NOT EXISTS (
      SELECT 1 FROM _dedup_pairs p
      WHERE (p.canonical_id = a.id OR p.canonical_id = b.id)
        AND (p.duplicate_id = a.id OR p.duplicate_id = b.id)
    );

  -- Tier 2: Fuzzy name match
  -- Location condition has three paths (any one sufficient):
  --   1. location_name string similarity >= 0.65 (standard case)
  --   2. name similarity >= 0.90 when location_name absent on either side
  --   3. one location name is a substring of the other — catches partial
  --      extractions ("ORCA" vs "ORCA Books", "Obsidian" vs "Obsidian Bar & Lounge")
  --      that fail string similarity but are clearly the same place. Compared on
  --      normalized forms so punctuation doesn't break the match.
  --
  -- Date condition has three tiers:
  --   1. Both dates known and close — standard temporal anchor
  --   2. One date known, one unknown — name/location carries the signal.
  --      This is exactly the path a recurring/specific pair takes (the
  --      recurring side has date_start NULL) — this is why the
  --      date_type_mismatch flag matters here specifically: this branch is
  --      the one letting mismatched date_types reach this tier at all.
  --   3. Both dates unknown — compensate with much higher name similarity (0.85)
  --      to avoid N² false-positive explosions among recurring/multi-flyer events
  --      (e.g. five null-date "Rad Pride" variants all matching each other)
  INSERT INTO _dedup_pairs
  SELECT
    CASE
      WHEN event_date_type_priority(a.date_type) > event_date_type_priority(b.date_type) THEN a.id
      WHEN event_date_type_priority(a.date_type) < event_date_type_priority(b.date_type) THEN b.id
      WHEN a.created_at <= b.created_at THEN a.id
      ELSE b.id
    END,
    CASE
      WHEN event_date_type_priority(a.date_type) > event_date_type_priority(b.date_type) THEN b.id
      WHEN event_date_type_priority(a.date_type) < event_date_type_priority(b.date_type) THEN a.id
      WHEN a.created_at <= b.created_at THEN b.id
      ELSE a.id
    END,
    'fuzzy',
    a.date_type IS DISTINCT FROM b.date_type
  FROM events a
  JOIN events b ON b.id > a.id AND b.is_active = true
  WHERE a.is_active = true
    AND similarity(normalize_event_name(a.name), normalize_event_name(b.name)) >= 0.65
    AND (
      (a.date_start IS NOT NULL AND b.date_start IS NOT NULL
       AND ABS(a.date_start - b.date_start) <= 1)
      OR (a.date_start IS NULL) != (b.date_start IS NULL)
      OR (a.date_start IS NULL AND b.date_start IS NULL
          AND similarity(normalize_event_name(a.name), normalize_event_name(b.name)) >= 0.85)
    )
    AND (
      (a.location_name IS NOT NULL AND b.location_name IS NOT NULL
       AND similarity(normalize_location_name(a.location_name), normalize_location_name(b.location_name)) >= 0.65)
      OR
      ((a.location_name IS NULL OR b.location_name IS NULL)
       AND similarity(normalize_event_name(a.name), normalize_event_name(b.name)) >= 0.90)
      OR
      (a.location_name IS NOT NULL AND b.location_name IS NOT NULL
       AND (
         normalize_location_name(a.location_name) LIKE '%' || normalize_location_name(b.location_name) || '%'
         OR normalize_location_name(b.location_name) LIKE '%' || normalize_location_name(a.location_name) || '%'
       ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM _dedup_pairs p
      WHERE (p.canonical_id = a.id OR p.canonical_id = b.id)
        AND (p.duplicate_id = a.id OR p.duplicate_id = b.id)
    );

  FOR v_pair IN
    SELECT dp.canonical_id, ec.name AS canonical_name,
           dp.duplicate_id, ed.name AS duplicate_name, dp.match_type, dp.date_type_mismatch
    FROM _dedup_pairs dp
    JOIN events ec ON ec.id = dp.canonical_id
    JOIN events ed ON ed.id = dp.duplicate_id
    ORDER BY dp.date_type_mismatch, dp.match_type, ec.name
  LOOP
    canonical_id   := v_pair.canonical_id;
    canonical_name := v_pair.canonical_name;
    duplicate_id   := v_pair.duplicate_id;
    duplicate_name := v_pair.duplicate_name;
    match_type     := v_pair.match_type;
    date_type_mismatch   := v_pair.date_type_mismatch;

    -- Mismatched-date_type pairs are always returned for visibility but
    -- never auto-merged, regardless of p_dry_run -- they stay separate
    -- by default. merge_events() can still be called on a specific pair
    -- by hand if it turns out to be the same flyer.
    IF NOT p_dry_run AND NOT v_pair.date_type_mismatch THEN
      PERFORM merge_events(v_pair.canonical_id, v_pair.duplicate_id, v_pair.match_type);
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$$;


-- ------------------------------------------------------------
-- GRANTS
-- schema_current.sql's "GRANT ALL ON ALL FUNCTIONS IN SCHEMA public
-- TO service_role" (see GRANTS section near the end of the schema)
-- was a one-time bulk statement -- it only covered functions that
-- existed when it ran, not ALTER DEFAULT PRIVILEGES. Two functions
-- here fall outside it and need their own explicit grant:
--   - event_date_type_priority() is brand new.
--   - run_dedup_pass() was DROPped and recreated above (required --
--     Postgres won't let CREATE OR REPLACE change a RETURNS TABLE
--     column list), so it's a new catalog object even though the
--     name is unchanged; its old grant doesn't carry over.
-- merge_events() needs no action: it kept its same signature's OID
-- via CREATE OR REPLACE (the new p_match_type param only has a
-- default appended), so its existing grant from the original bulk
-- statement still applies.
--
-- Postgres's actual default for a newly created function is EXECUTE
-- granted to PUBLIC (opposite of its table default). Nothing in
-- schema_current.sql overrides that with ALTER DEFAULT PRIVILEGES,
-- so rather than depend on whatever Supabase's platform-level
-- provisioning may or may not set, this pins both functions to the
-- same explicit, intentional state as the rest of the schema's
-- GRANTS section: service_role only, PUBLIC revoked.
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION event_date_type_priority(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION run_dedup_pass(BOOLEAN)        FROM PUBLIC;

GRANT EXECUTE ON FUNCTION event_date_type_priority(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION run_dedup_pass(BOOLEAN)        TO service_role;