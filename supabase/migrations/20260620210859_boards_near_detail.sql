-- Migration: boards_near_detail
-- Returns boards within radius, sorted by fuzzy relevance score:
--   active_flyer_count / sqrt(max(distance_m, 10))
-- A board with many flyers nearby beats a sparse one up close;
-- a large board far away stays competitive against a tiny one nearby.
-- GREATEST(..., 10) prevents a board at your exact location from
-- getting a runaway score.

CREATE OR REPLACE FUNCTION boards_near_detail(
  lat      float,
  lng      float,
  radius_m int DEFAULT 10000
)
RETURNS TABLE (
  id                           uuid,
  location_name                text,
  description                  text,
  managed_by                   text,
  requires_entry_to_photograph boolean,
  requires_entry_to_post       boolean,
  last_sighted_at              timestamptz,
  active_flyer_count           bigint,
  content_mix                  text[],
  distance_m                   float,
  relevance_score              float,
  board_lat                    float,
  board_lng                    float
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    bp.id,
    bp.location_name,
    bp.description,
    bp.managed_by,
    bp.requires_entry_to_photograph,
    bp.requires_entry_to_post,
    bp.last_sighted_at,
    bp.active_flyer_count,
    bp.content_mix,
    ST_Distance(
      bp.geolocation::geography,
      ST_MakePoint(lng, lat)::geography
    )                                                                        AS distance_m,
    bp.active_flyer_count::float /
      SQRT(GREATEST(
        ST_Distance(bp.geolocation::geography, ST_MakePoint(lng, lat)::geography),
        10.0
      ))                                                                     AS relevance_score,
    ST_Y(bp.geolocation::geometry)                                           AS board_lat,
    ST_X(bp.geolocation::geometry)                                           AS board_lng
  FROM boards_public bp
  WHERE ST_DWithin(
    bp.geolocation::geography,
    ST_MakePoint(lng, lat)::geography,
    radius_m
  )
  ORDER BY relevance_score DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION boards_near_detail TO anon;