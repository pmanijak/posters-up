-- Add a generated column with the normalized URL
ALTER TABLE event_verifications
  ADD COLUMN source_url_normalized TEXT
    GENERATED ALWAYS AS (
      regexp_replace(
        lower(regexp_replace(source_url, '^https?://(www\.)?', '', 'i')),
        '[?#].*$', '', 'g'   -- strip query string and fragment
      )
    ) STORED;

CREATE UNIQUE INDEX uq_event_verifications_normalized
  ON event_verifications (event_id, source_url_normalized);