-- Add lat/lng to event_board_locations so the frontend never has to parse
-- a PostGIS geography object. Run in Supabase SQL editor.

CREATE OR REPLACE VIEW event_board_locations AS
SELECT
  bf.event_id,
  b.id                           AS board_id,
  b.geolocation,
  b.description                  AS board_description,
  bf.first_seen_at,
  bf.last_seen_at,
  ST_Y(b.geolocation::geometry)  AS lat,
  ST_X(b.geolocation::geometry)  AS lng
FROM board_flyers bf
JOIN boards b ON b.id = bf.board_id
WHERE bf.is_active = true
  AND b.is_active  = true;