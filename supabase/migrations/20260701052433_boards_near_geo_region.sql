DROP FUNCTION boards_near(float, float, int);

CREATE FUNCTION boards_near(lat float, lng float, radius_m int DEFAULT 25000)
RETURNS TABLE(id uuid, geo_city text, geo_region text, geo_country text, distance_m float)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    b.id,
    b.geo_city,
    b.geo_region,
    b.geo_country,
    ST_Distance(b.geolocation::geography, ST_MakePoint(lng, lat)::geography) AS distance_m
  FROM boards b
  WHERE b.is_active = true
    AND ST_DWithin(b.geolocation::geography, ST_MakePoint(lng, lat)::geography, radius_m)
  ORDER BY distance_m
$$;

GRANT EXECUTE ON FUNCTION boards_near(float, float, int) TO anon;