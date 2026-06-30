-- Migration: add match_type to event_sightings
-- Records how this sighting was matched to a canonical event.
-- 'new' means no match was found and a new event was created.
-- Null for sightings created before this migration.

ALTER TABLE event_sightings
  ADD COLUMN match_type TEXT;
  -- 'url'             — matched via event_url hard match (tier 1)
  -- 'talent_anchor'   — matched via headliner + date + location (tier 1.5)
  -- 'location_anchor' — matched via exact date + high location sim + loose name (tier 1.7)
  --                     catches OCR failures where name is garbled but date/venue are clear
  -- 'fuzzy'           — matched via normalized name + date + location (tier 2)
  -- 'new'             — no match found; new event created
  -- null              — pre-migration sighting

COMMENT ON COLUMN event_sightings.match_type IS
  'How this sighting was matched to its canonical event. new = no match found.';

CREATE INDEX idx_sightings_match_type ON event_sightings(match_type)
  WHERE match_type IS NOT NULL;