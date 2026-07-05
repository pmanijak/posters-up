-- Extraction queue: bounded-concurrency drain of photos.extraction_status.
-- See supabase/functions/extract-drain/README.md for the full design.

-- processing_started_at, not submitted_at, is the reap clock. submitted_at
-- is stamped at upload time and predates the claim by however long a photo
-- sat pending — using it to judge staleness would make a photo that waited
-- a while in queue look stuck sooner than a freshly-claimed one actually is.
ALTER TABLE photos
  ADD COLUMN processing_started_at TIMESTAMPTZ;

-- Persists what was previously only a request-scoped variable inside
-- extract's handler (capturedAt, derived from EXIF capture_date). Needed
-- once extraction can be triggered by something other than the original
-- upload request (a claim-and-dispatch call, or the cron backstop) —
-- those callers only have a photo_id, not the original request body.
ALTER TABLE photos
  ADD COLUMN captured_at TIMESTAMPTZ;

INSERT INTO config (key, value, description) VALUES
  ('extract_max_concurrent',
   '10',
   'Max photos in extraction_status = processing at once, across both the push dispatch and the extract-drain cron backstop'),
  ('extraction_stale_processing_minutes',
   '5',
   'Minutes a photo can sit in extraction_status = processing before extract-drain assumes the invocation died and reaps it back to pending. Kept comfortably above the ~150s Edge Function idle timeout.')
ON CONFLICT (key) DO NOTHING;