-- ============================================================
-- Migration: add reverse-geocode cache columns to boards
--
-- geo_city, geo_region, geo_country store the human-readable
-- location derived from boards.geolocation via Nominatim.
-- Populated lazily the first time an event on that board is
-- enriched; reused on every subsequent enrichment call without
-- hitting Nominatim again.
--
-- Intentionally separate from 'description' (which is a
-- navigation hint written by the contributor) — these are
-- machine-generated from coordinates.
-- ============================================================

ALTER TABLE boards
  ADD COLUMN IF NOT EXISTS geo_city    TEXT,
  ADD COLUMN IF NOT EXISTS geo_region  TEXT,
  ADD COLUMN IF NOT EXISTS geo_country TEXT;

COMMENT ON COLUMN boards.geo_city    IS 'City name from reverse geocoding boards.geolocation. Populated by the enrichment pipeline; do not set manually.';
COMMENT ON COLUMN boards.geo_region  IS 'State/region from reverse geocoding boards.geolocation.';
COMMENT ON COLUMN boards.geo_country IS 'ISO 3166-1 alpha-2 country code (uppercase) from reverse geocoding boards.geolocation.';