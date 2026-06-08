CREATE OR REPLACE FUNCTION find_nearby_board(
  p_lat FLOAT,
  p_lng FLOAT,
  p_radius_meters FLOAT DEFAULT 20
)
RETURNS TABLE(id UUID)
LANGUAGE sql
AS $$
  SELECT id
  FROM boards
  WHERE is_active = true
    AND ST_DWithin(
      geolocation,
      ST_MakePoint(p_lng, p_lat)::geography,
      p_radius_meters
    )
  ORDER BY ST_Distance(geolocation, ST_MakePoint(p_lng, p_lat)::geography)
  LIMIT 1;
$$;
