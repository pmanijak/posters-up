-- ============================================================
-- Add geo_neighborhood + available_areas()
-- Purpose: let the city picker offer "Seattle - Fremont" style
-- selections without requiring the user's exact location.
--
-- This is additive and non-breaking:
--   - geo_neighborhood is nullable, same lazy-cache pattern as
--     geo_city/geo_region/geo_country
--   - available_cities() is untouched; available_areas() sits
--     alongside it
--   - No decision is made here about *when* to show the
--     neighborhood split (threshold vs. map-pin UX) — that's a
--     presentation-layer choice for later. This migration just
--     makes the data available.
-- ============================================================

-- ------------------------------------------------------------
-- 1. New column
-- ------------------------------------------------------------
ALTER TABLE boards
  ADD COLUMN geo_neighborhood TEXT;

COMMENT ON COLUMN boards.geo_neighborhood IS
  'Machine-generated from boards.geolocation via Nominatim (suburb/neighbourhood '
  'field of the same reverse-geocode response that fills geo_city/geo_region). '
  'Populated lazily by the enrichment pipeline; do not set manually. Null is '
  'expected and common — many Nominatim responses have no neighbourhood-level '
  'result, and unlike geo_city this is never backfilled or defaulted.';

-- ------------------------------------------------------------
-- 2. available_areas() — sibling of available_cities(), one
-- level more granular. Groups by (geo_city, geo_neighborhood)
-- instead of geo_city alone. geo_neighborhood is nullable in
-- the result: a board with no neighbourhood-level match still
-- rolls up under its city with geo_neighborhood = NULL, so the
-- frontend can always fall back to "just the city" per row.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION available_areas()
RETURNS TABLE(
  geo_city         text,
  geo_neighborhood text,
  lat              float,
  lng              float,
  board_count      int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    geo_city,
    geo_neighborhood,
    AVG(ST_Y(geolocation::geometry))::float AS lat,
    AVG(ST_X(geolocation::geometry))::float AS lng,
    COUNT(*)::int AS board_count
  FROM boards
  WHERE is_active = true
    AND geo_city IS NOT NULL
  GROUP BY geo_city, geo_neighborhood
  ORDER BY geo_city, geo_neighborhood NULLS FIRST
$$;

GRANT EXECUTE ON FUNCTION available_areas() TO anon;