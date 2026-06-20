-- migration: drop crop_url and crop_generated_at from event_sightings
-- these columns were never populated; visual flyer display deferred indefinitely

ALTER TABLE event_sightings
  DROP COLUMN IF EXISTS crop_url,
  DROP COLUMN IF EXISTS crop_generated_at;