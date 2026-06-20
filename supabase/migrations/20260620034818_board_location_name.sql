-- ============================================================
-- Add location_name to boards and board_submissions
-- Idempotent — safe to run multiple times
-- ============================================================

-- Business or place name, separate from the navigation description.
-- "Rainy Day Records" vs "outside the front door on 4th Ave"
ALTER TABLE boards
  ADD COLUMN IF NOT EXISTS location_name TEXT;

ALTER TABLE board_submissions
  ADD COLUMN IF NOT EXISTS location_name TEXT;


-- ============================================================
-- Recreate event_board_locations with location_name
-- ============================================================

DROP VIEW IF EXISTS event_board_locations;

CREATE VIEW event_board_locations AS
SELECT
  bf.event_id,
  b.id                           AS board_id,
  b.geolocation,
  b.description                  AS board_description,
  bf.first_seen_at,
  bf.last_seen_at,
  ST_Y(b.geolocation::geometry)  AS lat,
  ST_X(b.geolocation::geometry)  AS lng,
  b.managed_by,
  b.requires_entry_to_photograph,
  b.location_name
FROM board_flyers bf
JOIN boards b ON b.id = bf.board_id
WHERE bf.is_active = true
  AND b.is_active  = true;


-- ============================================================
-- Recreate boards_public with location_name
-- ============================================================

DROP VIEW IF EXISTS boards_public;

CREATE VIEW boards_public AS
SELECT
  b.id,
  b.geolocation,
  b.description,
  b.managed_by,
  b.posting_policy,
  b.allowed_content_types,
  b.requires_entry_to_photograph,
  b.requires_entry_to_post,
  b.first_sighted_at,
  b.last_sighted_at,
  COUNT(bf.id) FILTER (WHERE bf.is_active = true)  AS active_flyer_count,
  COUNT(bf.id)                                      AS total_flyer_count,
  ARRAY_AGG(DISTINCT e.content_type)
    FILTER (WHERE bf.is_active = true)              AS content_mix,
  b.location_name
FROM boards b
LEFT JOIN board_flyers bf ON bf.board_id = b.id
LEFT JOIN events e        ON e.id = bf.event_id
WHERE b.is_active = true
GROUP BY b.id;

-- ============================================================
-- Update apply_board_submission to write location_name
-- location_name: most recent approved value wins (no AI correction,
-- it's a proper noun — capitalization is the contributor's call)
-- ============================================================

CREATE OR REPLACE FUNCTION apply_board_submission(p_board_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_location_name                TEXT;
  v_description                  TEXT;
  v_requires_entry_to_photograph BOOLEAN;
  v_requires_entry_to_post       BOOLEAN;
BEGIN
  -- location_name: most recent approved submission
  SELECT location_name
  INTO v_location_name
  FROM board_submissions
  WHERE board_id      = p_board_id
    AND review_status = 'auto_approved'
    AND location_name IS NOT NULL
  ORDER BY submitted_at DESC
  LIMIT 1;

  -- description: most recent approved submission, AI correction preferred
  SELECT COALESCE(corrected_description, description)
  INTO v_description
  FROM board_submissions
  WHERE board_id      = p_board_id
    AND review_status = 'auto_approved'
    AND (description IS NOT NULL OR corrected_description IS NOT NULL)
  ORDER BY submitted_at DESC
  LIMIT 1;

  -- entry flags: majority vote across approved submissions
  SELECT mode() WITHIN GROUP (ORDER BY requires_entry_to_photograph)
  INTO v_requires_entry_to_photograph
  FROM board_submissions
  WHERE board_id      = p_board_id
    AND review_status = 'auto_approved'
    AND requires_entry_to_photograph IS NOT NULL;

  SELECT mode() WITHIN GROUP (ORDER BY requires_entry_to_post)
  INTO v_requires_entry_to_post
  FROM board_submissions
  WHERE board_id      = p_board_id
    AND review_status = 'auto_approved'
    AND requires_entry_to_post IS NOT NULL;

  -- Write back only fields with at least one approved value.
  -- COALESCE preserves existing boards value when no submissions
  -- have data for that field yet.
  UPDATE boards
  SET
    location_name                = COALESCE(v_location_name,                location_name),
    description                  = COALESCE(v_description,                  description),
    requires_entry_to_photograph = COALESCE(v_requires_entry_to_photograph, requires_entry_to_photograph),
    requires_entry_to_post       = COALESCE(v_requires_entry_to_post,       requires_entry_to_post),
    updated_at                   = now()
  WHERE id = p_board_id;
END;
$$;