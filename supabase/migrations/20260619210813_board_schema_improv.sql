-- Drop view if it exists
DROP VIEW IF EXISTS boards_public;

-- Drop is_indoor only if it still exists
ALTER TABLE boards
  DROP COLUMN IF EXISTS is_indoor,
  ADD COLUMN IF NOT EXISTS requires_entry_to_photograph BOOLEAN,
  ADD COLUMN IF NOT EXISTS requires_entry_to_post       BOOLEAN;

-- Recreate the view (CREATE OR REPLACE is already idempotent)
CREATE OR REPLACE VIEW boards_public AS
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
    FILTER (WHERE bf.is_active = true)              AS content_mix
FROM boards b
LEFT JOIN board_flyers bf ON bf.board_id = b.id
LEFT JOIN events e        ON e.id = bf.event_id
WHERE b.is_active = true
GROUP BY b.id;