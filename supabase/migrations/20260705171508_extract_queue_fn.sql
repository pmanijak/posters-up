-- ------------------------------------------------------------
-- BOARD LAT/LNG
-- Lets runExtraction derive coordinates from the already-resolved board
-- instead of needing lat/lng passed in from the original request — the
-- request that created a photo row isn't necessarily the same invocation
-- that ends up running its extraction (claim_pending_photos may hand it
-- to a later call, or the cron backstop).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION board_lat_lng(p_board_id UUID)
RETURNS TABLE(lat FLOAT, lng FLOAT)
LANGUAGE sql
AS $$
  SELECT ST_Y(geolocation::geometry), ST_X(geolocation::geometry)
  FROM boards WHERE id = p_board_id;
$$;

-- ------------------------------------------------------------
-- CLAIM PENDING PHOTOS
-- Atomically claims up to (extract_max_concurrent - currently processing)
-- oldest pending photos, flips them to 'processing', and returns their ids.
-- FOR UPDATE SKIP LOCKED makes concurrent callers (push dispatch calls
-- from upload/extract, and the extract-drain cron backstop) safe to run
-- at the same time without double-claiming a row.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_pending_photos()
RETURNS TABLE(id UUID)
LANGUAGE plpgsql
AS $$
DECLARE
  v_max_concurrent INT;
  v_processing     INT;
  v_slots          INT;
BEGIN
  SELECT value::int INTO v_max_concurrent
  FROM config WHERE key = 'extract_max_concurrent';

  SELECT COUNT(*) INTO v_processing
  FROM photos WHERE extraction_status = 'processing';

  v_slots := GREATEST(v_max_concurrent - v_processing, 0);

  IF v_slots = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE photos
  SET extraction_status = 'processing',
      processing_started_at = now()
  WHERE photos.id IN (
    SELECT p.id FROM photos p
    WHERE p.extraction_status = 'pending'
    ORDER BY p.submitted_at ASC
    LIMIT v_slots
    FOR UPDATE SKIP LOCKED
  )
  RETURNING photos.id;
END;
$$;

-- ------------------------------------------------------------
-- REAP STALE PROCESSING PHOTOS
-- Recovers photos whose extract invocation died mid-flight (worker OOM,
-- wall-clock timeout, boot failure racing a deploy) and therefore never
-- reached any of extract's own status-writing code paths. Resets them to
-- 'pending' so the next claim picks them back up. Returns how many were
-- reaped, for logging.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION reap_stale_processing_photos()
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_stale_minutes INT;
  v_reaped        INT;
BEGIN
  SELECT value::int INTO v_stale_minutes
  FROM config WHERE key = 'extraction_stale_processing_minutes';

  UPDATE photos
  SET extraction_status = 'pending',
      processing_started_at = NULL
  WHERE extraction_status = 'processing'
    AND processing_started_at < now() - (v_stale_minutes || ' minutes')::interval;

  GET DIAGNOSTICS v_reaped = ROW_COUNT;
  RETURN v_reaped;
END;
$$;