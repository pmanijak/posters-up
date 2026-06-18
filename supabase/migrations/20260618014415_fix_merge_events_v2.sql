-- ============================================================
-- Patch: fix merge_events() step 3 (verifications)
--
-- ON CONFLICT ON CONSTRAINT fails when the unique constraint is
-- implemented as an index rather than a named constraint.
-- Fix: delete conflicting rows first, then plain UPDATE.
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
  UPDATE event_sightings
  SET event_id = p_canonical_id
  WHERE event_id = p_duplicate_id;

  -- 2. Board flyers (upsert to handle UNIQUE(board_id, event_id))
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

  -- 3. Verifications
  --    Drop any of the duplicate's rows whose URL the canonical already has,
  --    then re-point the rest with a plain UPDATE.
  --    The dropped rows are redundant — canonical already has that confirmation.
  DELETE FROM event_verifications
  WHERE event_id = p_duplicate_id
    AND source_url_normalized IN (
      SELECT source_url_normalized
      FROM event_verifications
      WHERE event_id = p_canonical_id
    );

  UPDATE event_verifications
  SET event_id = p_canonical_id
  WHERE event_id = p_duplicate_id;

  -- 4. Talent (ON CONFLICT DO NOTHING — canonical wins)
  INSERT INTO event_talent (event_id, talent_id, role, billing_position, created_at)
  SELECT p_canonical_id, talent_id, role, billing_position, created_at
  FROM event_talent
  WHERE event_id = p_duplicate_id
  ON CONFLICT (event_id, talent_id) DO NOTHING;

  DELETE FROM event_talent WHERE event_id = p_duplicate_id;

  -- 5. Reports
  UPDATE event_reports
  SET event_id = p_canonical_id
  WHERE event_id = p_duplicate_id;

  -- 6. Merge fields onto canonical
  UPDATE events SET
    tags             = ARRAY(SELECT DISTINCT unnest(
                         COALESCE(tags, '{}') || COALESCE(v_dup.tags, '{}')
                       )),
    accessibility    = ARRAY(SELECT DISTINCT unnest(
                         COALESCE(accessibility, '{}') || COALESCE(v_dup.accessibility, '{}')
                       )),
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
    enrichment_attempted_at = NULL,
    updated_at       = now()
  WHERE id = p_canonical_id;

  -- 7. Deactivate duplicate
  UPDATE events
  SET is_active = false, updated_at = now()
  WHERE id = p_duplicate_id;

  -- 8. Recompute confidence
  PERFORM compute_event_confidence(p_canonical_id);

END;
$$;