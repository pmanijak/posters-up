-- supabase/migrations/nearby_boards.sql
CREATE OR REPLACE FUNCTION boards_near(lat float, lng float, radius_m int DEFAULT 25000)
RETURNS TABLE(id uuid, geo_city text, distance_m float)
LANGUAGE sql
AS $$
  SELECT
    b.id,
    b.geo_city,
    ST_Distance(b.geolocation::geography, ST_MakePoint(lng, lat)::geography) AS distance_m
  FROM boards b
  WHERE b.is_active = true
    AND ST_DWithin(b.geolocation::geography, ST_MakePoint(lng, lat)::geography, radius_m)
  ORDER BY distance_m
$$;