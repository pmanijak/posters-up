-- ============================================================
-- MIGRATION: split_event()
-- ============================================================
--
-- The structural inverse of merge_events(). Peels a given set of
-- event_sightings off an existing event into a brand-new event,
-- correctly redistributing board_flyers and event_talent between the
-- two resulting events, re-queuing both for enrichment, and resolving
-- any pending 'possible_false_merge' event_reports row for the
-- original event.
--
-- This does NOT decide which sightings belong together — that's a
-- human judgment call (see ARCHITECTURE.md: "when in doubt, create a
-- new event" already establishes that merge decisions are conservative
-- and human-reviewable; the same applies in reverse to un-merging).
-- run_field_reconciliation_pass() flags likely false merges into
-- event_reports; a human (or a future, more targeted helper) decides
-- the actual sighting_ids to peel off and calls this function.
--
-- Reuniting a split-off group with an ALREADY-EXISTING event (rather
-- than a fresh one) isn't a separate mode here — compose the two
-- existing primitives instead: split_event() to peel the sightings
-- into a new event, then merge_events() to fold that new event into
-- the pre-existing target.
--
-- ------------------------------------------------------------
-- WHAT MOVES, WHAT DOESN'T
-- ------------------------------------------------------------
-- event_sightings   — moved: event_id reassigned to the new event.
-- board_flyers      — recomputed for both events from their resulting
--                      (post-split) event_sightings, not patched in
--                      place. The old event's board_flyers row for a
--                      board is deleted if no remaining (non-moved)
--                      sighting still touches that board; kept and its
--                      timestamps recomputed otherwise. is_active and
--                      removed_at on rows the old event keeps are left
--                      untouched — those can reflect manual moderation
--                      action and shouldn't be silently overwritten by
--                      a delete-and-reinsert.
-- event_talent      — talent is attached to the new event based on what
--                      the MOVED sightings' raw_extraction actually
--                      mentions (matched to the existing talent table
--                      by canonical_name; never creates new talent rows
--                      — they should already exist from the original
--                      extraction). Detached from the old event only if
--                      no REMAINING sighting still mentions that talent
--                      — a talent attested by both groups legitimately
--                      stays linked to both.
-- event_verifications — NOT moved or touched. Enrichment sources found
--                      under the (possibly wrong) merged identity may
--                      not apply to either resulting event. Instead,
--                      enrichment_attempted_at is reset to NULL on BOTH
--                      events so they're re-queued and re-verified
--                      under their now-correct identities. Cheap:
--                      re-enrichment uses Haiku per the enrich function
--                      design (see enrich_README.md).
-- organization_id/venue_id — NOT set on the new event. Resolving these
--                      requires the same upsert-by-canonical-name logic
--                      the extract Edge Function uses, which has no SQL
--                      equivalent here. Left null; a human or a future
--                      pass can backfill.
-- event_reports      — any pending 'possible_false_merge' report on the
--                      old event is marked resolved, referencing the
--                      new event_id, closing the loop that
--                      run_field_reconciliation_pass() opened.
--
-- ------------------------------------------------------------
-- SAFETY
-- ------------------------------------------------------------
-- Refuses to run if:
--   - p_event_id doesn't exist or isn't active
--   - p_sighting_ids is empty
--   - any id in p_sighting_ids belongs to a different event (fails
--     loudly rather than silently ignoring the mismatched ids — wrong
--     input should error, not do something quietly different)
--   - moving p_sighting_ids would leave the old event with zero
--     sightings (that's not a split, use merge_events or deactivate)
--
-- Defaults to dry run — returns what WOULD happen (including a
-- preview new_event_id generated but not persisted) without writing
-- anything. Pass p_dry_run := false to execute.
--
-- Usage:
--   -- 1. Identify the sightings to peel off by hand:
--   SELECT id, sighted_at, board_id, raw_extraction->>'name'
--   FROM event_sightings
--   WHERE event_id = '<event_id>'
--   ORDER BY sighted_at;
--
--   -- 2. Dry run:
--   SELECT * FROM split_event('<event_id>', ARRAY['<id1>','<id2>']::UUID[]);
--
--   -- 3. Live:
--   SELECT * FROM split_event('<event_id>', ARRAY['<id1>','<id2>']::UUID[], false);
--
-- Worked example against the "One Day Closer to Doom" false-merge case:
--   SELECT id, sighted_at, board_id, raw_extraction->>'name'
--   FROM event_sightings
--   WHERE event_id = 'a07dc92b-62b9-40e0-8924-36c44d504d33'
--     AND raw_extraction->>'name' ILIKE 'wild child%'
--   ORDER BY sighted_at;
--   -- then feed the resulting ids into split_event() as above.
--   -- Repeat separately for the "Pride Soirée" sightings on the same event.
-- ============================================================

CREATE OR REPLACE FUNCTION split_event(
  p_event_id     UUID,
  p_sighting_ids UUID[],
  p_dry_run      BOOLEAN DEFAULT true
)
RETURNS TABLE (
  new_event_id             UUID,
  new_event_name           TEXT,
  sightings_moved          INT,
  boards_affected          INT,
  talent_moved             INT,
  old_event_boards_removed INT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_old                events%ROWTYPE;
  v_seed                event_sightings%ROWTYPE;  -- highest-confidence moved sighting; seeds the new event's fields
  v_new_event_id        UUID;
  v_old_sighting_count  INT;
  v_moved_count         INT;
  v_boards_count        INT;
  v_talent_count        INT;
  v_old_boards_removed  INT;
BEGIN
  -- ── Validate ──────────────────────────────────────────────────────────
  SELECT * INTO v_old FROM events WHERE id = p_event_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'split_event: event % not found or not active', p_event_id;
  END IF;

  IF p_sighting_ids IS NULL OR array_length(p_sighting_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'split_event: p_sighting_ids must be non-empty';
  END IF;

  IF EXISTS (
    SELECT 1 FROM event_sightings s
    WHERE s.id = ANY(p_sighting_ids) AND s.event_id != p_event_id
  ) THEN
    RAISE EXCEPTION 'split_event: one or more sighting_ids do not belong to event %', p_event_id;
  END IF;

  SELECT COUNT(*) INTO v_old_sighting_count FROM event_sightings WHERE event_id = p_event_id;
  SELECT COUNT(*) INTO v_moved_count FROM event_sightings WHERE id = ANY(p_sighting_ids);

  IF v_moved_count = 0 THEN
    RAISE EXCEPTION 'split_event: no matching sightings found for the given ids';
  END IF;

  IF v_moved_count >= v_old_sighting_count THEN
    RAISE EXCEPTION 'split_event: cannot move all % sighting(s) — event % would be left with none. Use merge_events or deactivate instead.',
      v_old_sighting_count, p_event_id;
  END IF;

  -- Seed the new event's fields from the highest-confidence moved
  -- sighting — the same "founding sighting" pattern the extract Edge
  -- Function uses when creating an event for the first time.
  SELECT * INTO v_seed
  FROM event_sightings
  WHERE id = ANY(p_sighting_ids)
  ORDER BY extraction_confidence DESC
  LIMIT 1;

  -- Generated up front even in dry-run mode — gen_random_uuid() is a
  -- pure function with no side effects, so this is safe to preview.
  v_new_event_id := gen_random_uuid();

  -- Pre-compute summary counts before any writes, so the dry-run
  -- report and the live-run report reflect the same numbers.
  SELECT COUNT(DISTINCT board_id) INTO v_boards_count
  FROM event_sightings WHERE id = ANY(p_sighting_ids) AND board_id IS NOT NULL;

  SELECT COUNT(DISTINCT t.id) INTO v_talent_count
  FROM event_sightings s
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.raw_extraction->'talent', '[]'::jsonb)) AS talent_entry
  JOIN talent t ON t.canonical_name = lower(trim(talent_entry->>'name'))
  WHERE s.id = ANY(p_sighting_ids);

  SELECT COUNT(*) INTO v_old_boards_removed
  FROM board_flyers bf
  WHERE bf.event_id = p_event_id
    AND bf.board_id NOT IN (
      SELECT DISTINCT board_id FROM event_sightings
      WHERE event_id = p_event_id
        AND NOT (id = ANY(p_sighting_ids))
        AND board_id IS NOT NULL
    );

  IF p_dry_run THEN
    new_event_id             := v_new_event_id;
    new_event_name           := v_seed.raw_extraction->>'name';
    sightings_moved          := v_moved_count;
    boards_affected          := v_boards_count;
    talent_moved             := v_talent_count;
    old_event_boards_removed := v_old_boards_removed;
    RETURN NEXT;
    RETURN;
  END IF;

  -- ── Create the new event, seeded from the founding sighting ─────────
  -- tags/accessibility use a jsonb_typeof guard rather than a plain
  -- jsonb_array_elements_text() call: raw_extraction can legitimately
  -- contain a JSON null (Claude returned null, not an empty array) —
  -- calling the array-element function directly on a JSON null/scalar
  -- raises "cannot extract elements from a scalar", so the type is
  -- checked first and an empty array substituted for anything that
  -- isn't a JSON array.
  INSERT INTO events (
    id, name, content_type, event_category, tags, flyer_style,
    date_type, date_start, date_end, time_start, time_end,
    recurrence_rule, date_raw, location_name, location_address,
    description, contact, event_url, price_raw, is_free,
    age_restriction, is_public, language, is_outdoor, accessibility,
    masks_required, rsvp_required, rsvp_url,
    first_sighted_at, last_sighted_at
  )
  SELECT
    v_new_event_id,
    v_seed.raw_extraction->>'name',
    COALESCE(v_seed.raw_extraction->>'content_type', 'event'),
    v_seed.raw_extraction->>'event_category',
    CASE WHEN jsonb_typeof(v_seed.raw_extraction->'tags') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(v_seed.raw_extraction->'tags'))
      ELSE '{}'::TEXT[]
    END,
    v_seed.raw_extraction->>'flyer_style',
    COALESCE(v_seed.raw_extraction->>'date_type', 'unknown'),
    (v_seed.raw_extraction->>'date_start')::DATE,
    (v_seed.raw_extraction->>'date_end')::DATE,
    (v_seed.raw_extraction->>'time_start')::TIME,
    (v_seed.raw_extraction->>'time_end')::TIME,
    v_seed.raw_extraction->>'recurrence_rule',
    v_seed.raw_extraction->>'date_raw',
    v_seed.raw_extraction->>'location_name',
    v_seed.raw_extraction->>'location_address',
    v_seed.raw_extraction->>'description',
    v_seed.raw_extraction->>'contact',
    v_seed.raw_extraction->>'event_url',
    v_seed.raw_extraction->>'price_raw',
    (v_seed.raw_extraction->>'is_free')::BOOLEAN,
    v_seed.raw_extraction->>'age_restriction',
    (v_seed.raw_extraction->>'is_public')::BOOLEAN,
    v_seed.raw_extraction->>'language',
    (v_seed.raw_extraction->>'is_outdoor')::BOOLEAN,
    CASE WHEN jsonb_typeof(v_seed.raw_extraction->'accessibility') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(v_seed.raw_extraction->'accessibility'))
      ELSE '{}'::TEXT[]
    END,
    v_seed.raw_extraction->>'masks_required',
    (v_seed.raw_extraction->>'rsvp_required')::BOOLEAN,
    v_seed.raw_extraction->>'rsvp_url',
    (SELECT MIN(sighted_at) FROM event_sightings WHERE id = ANY(p_sighting_ids)),
    (SELECT MAX(sighted_at) FROM event_sightings WHERE id = ANY(p_sighting_ids));

  -- ── Reassign sightings ────────────────────────────────────────────
  -- Everything below this point depends on event_sightings already
  -- reflecting the post-split state, so this must run first.
  UPDATE event_sightings
  SET event_id = v_new_event_id
  WHERE id = ANY(p_sighting_ids);

  -- ── Board flyers: new event gets fresh rows ──────────────────────
  INSERT INTO board_flyers (board_id, event_id, first_seen_at, last_seen_at, is_active)
  SELECT s.board_id, v_new_event_id, MIN(s.sighted_at), MAX(s.sighted_at), true
  FROM event_sightings s
  WHERE s.event_id = v_new_event_id AND s.board_id IS NOT NULL
  GROUP BY s.board_id
  ON CONFLICT (board_id, event_id) DO NOTHING;  -- defensive; shouldn't fire for a brand-new event_id

  -- ── Board flyers: old event loses rows no remaining sighting touches ──
  DELETE FROM board_flyers
  WHERE event_id = p_event_id
    AND board_id NOT IN (
      SELECT DISTINCT board_id FROM event_sightings
      WHERE event_id = p_event_id AND board_id IS NOT NULL
    );

  -- ── Board flyers: old event's remaining rows get timestamps
  --    recomputed — the moved sightings may have been the most recent
  --    (or earliest) observations on a board it still shares. is_active
  --    and removed_at are deliberately not touched here (see header). ──
  UPDATE board_flyers bf
  SET last_seen_at  = sub.last_seen_at,
      first_seen_at = LEAST(bf.first_seen_at, sub.first_seen_at)
  FROM (
    SELECT board_id, MIN(sighted_at) AS first_seen_at, MAX(sighted_at) AS last_seen_at
    FROM event_sightings
    WHERE event_id = p_event_id AND board_id IS NOT NULL
    GROUP BY board_id
  ) sub
  WHERE bf.event_id = p_event_id AND bf.board_id = sub.board_id;

  -- ── Talent: attach to the new event based on what moved sightings
  --    actually mention. Picks role/billing_position from whichever
  --    moved sighting mentioning that talent has the highest
  --    extraction_confidence — same "trust the clearer read" principle
  --    as run_field_reconciliation_pass(). ──
  INSERT INTO event_talent (event_id, talent_id, role, billing_position)
  SELECT DISTINCT ON (t.id)
    v_new_event_id, t.id,
    talent_entry->>'role',
    (talent_entry->>'billing_position')::INT
  FROM event_sightings s
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.raw_extraction->'talent', '[]'::jsonb)) AS talent_entry
  JOIN talent t ON t.canonical_name = lower(trim(talent_entry->>'name'))
  WHERE s.id = ANY(p_sighting_ids)
  ORDER BY t.id, s.extraction_confidence DESC
  ON CONFLICT (event_id, talent_id) DO NOTHING;

  -- ── Talent: detach from old event only if no remaining sighting
  --    still mentions it — a talent attested by both groups legitimately
  --    stays linked to both events. ──
  DELETE FROM event_talent
  WHERE event_id = p_event_id
    AND talent_id NOT IN (
      SELECT t.id
      FROM event_sightings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.raw_extraction->'talent', '[]'::jsonb)) AS talent_entry
      JOIN talent t ON t.canonical_name = lower(trim(talent_entry->>'name'))
      WHERE s.event_id = p_event_id
    );

  -- ── Enrichment: both events' identities changed — re-queue both.
  --    event_verifications are deliberately left in place, not moved or
  --    deleted (see header); this just makes both events eligible for
  --    fresh enrichment under their now-correct identities. ──
  UPDATE events SET enrichment_attempted_at = NULL WHERE id IN (p_event_id, v_new_event_id);

  -- ── Close the loop: resolve any pending false-merge report this
  --    split addresses. ──
  UPDATE event_reports
  SET status          = 'resolved',
      resolved_by     = 'split_event',
      resolution_note = format('Split into new event %s ("%s")', v_new_event_id, v_seed.raw_extraction->>'name'),
      resolved_at     = now()
  WHERE event_id = p_event_id
    AND report_type = 'possible_false_merge'
    AND status = 'pending';

  -- ── Recompute confidence + search_text on both resulting events.
  --    compute_event_confidence() calls generate_search_text()
  --    internally — no separate call needed. ──
  PERFORM compute_event_confidence(p_event_id);
  PERFORM compute_event_confidence(v_new_event_id);

  new_event_id             := v_new_event_id;
  new_event_name           := v_seed.raw_extraction->>'name';
  sightings_moved          := v_moved_count;
  boards_affected          := v_boards_count;
  talent_moved              := v_talent_count;
  old_event_boards_removed := v_old_boards_removed;
  RETURN NEXT;
END;
$$;