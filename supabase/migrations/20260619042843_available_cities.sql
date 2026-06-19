CREATE OR REPLACE FUNCTION available_cities()
RETURNS TABLE(geo_city text, geo_region text, lat float, lng float, board_count int)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    geo_city,
    geo_region,
    AVG(ST_Y(geolocation::geometry))::float AS lat,
    AVG(ST_X(geolocation::geometry))::float AS lng,
    COUNT(*)::int AS board_count
  FROM boards
  WHERE is_active = true
    AND geo_city IS NOT NULL
  GROUP BY geo_city, geo_region
  ORDER BY geo_city
$$;

GRANT EXECUTE ON FUNCTION available_cities() TO anon;