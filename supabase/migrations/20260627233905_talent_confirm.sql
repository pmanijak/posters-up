-- Add confirmed flag to event_talent
-- Default false: all existing talent is unconfirmed until independently corroborated.
-- Presentation layer: only show enrichment links/bios when confirmed = true.

ALTER TABLE event_talent
  ADD COLUMN confirmed BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_event_talent_confirmed
  ON event_talent(event_id) WHERE confirmed = true;