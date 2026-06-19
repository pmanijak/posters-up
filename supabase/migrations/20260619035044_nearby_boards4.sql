GRANT SELECT ON public.boards TO anon;

-- Tables the discovery page needs to read
CREATE POLICY "public read" ON boards       FOR SELECT TO anon USING (true);
CREATE POLICY "public read" ON board_flyers FOR SELECT TO anon USING (true);
CREATE POLICY "public read" ON events       FOR SELECT TO anon USING (true);
CREATE POLICY "public read" ON organizations FOR SELECT TO anon USING (true);
CREATE POLICY "public read" ON venues       FOR SELECT TO anon USING (true);
CREATE POLICY "public read" ON talent       FOR SELECT TO anon USING (true);
CREATE POLICY "public read" ON event_talent FOR SELECT TO anon USING (true);

CREATE OR REPLACE FUNCTION boards_near(lat float, lng float, radius_m int DEFAULT 25000)
RETURNS TABLE(id uuid, geo_city text, distance_m float)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
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