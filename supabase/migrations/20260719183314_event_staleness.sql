-- ============================================================
-- Read-time event staleness.
--
-- Replaces the never-implemented nightly expiry sweep that has sat
-- commented out at the bottom of the schema since the first draft.
-- Staleness is a judgment made at read time from config values that
-- are expected to be tuned, not a state written onto the row:
--
--   * changing event_staleness_days takes effect on the next read,
--     in both directions -- a write-time sweep can only ever be
--     tightened, never loosened, because nothing un-expires a row
--   * an event that goes quiet and is later re-photographed comes
--     back on its own record, keeping its board count, confidence
--     history and id. A sweep that set is_active = false would hide
--     it from find_event_match() and fork a duplicate instead
--   * nothing claims a poster was removed. Filtering a read asserts
--     only "not seen recently", which is true; writing removed_at
--     would assert an observation nobody made. This is the rule the
--     board_flyers comment already states
--
-- Clock runs from last_sighted_at, so a flyer that keeps appearing
-- in new photos keeps renewing its own life.
-- ============================================================

CREATE OR REPLACE FUNCTION event_is_stale(
  p_date_type       TEXT,
  p_last_sighted_at TIMESTAMPTZ,
  p_staleness_days  INT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  -- STABLE, not IMMUTABLE: reads config and now().
  -- The COALESCE fallbacks mirror the config defaults. They exist so a
  -- missing config row degrades to "show the event" rather than
  -- returning NULL, which under `NOT event_is_stale(...)` would filter
  -- the row out and silently empty the feed.
  SELECT p_last_sighted_at < now() - (
    CASE
      WHEN p_date_type = 'recurring' THEN
        COALESCE((SELECT value::int FROM config
                   WHERE key = 'recurring_event_staleness_days'), 90)
      ELSE
        COALESCE(p_staleness_days,
                 (SELECT value::int FROM config
                   WHERE key = 'event_staleness_days'), 30)
    END || ' days')::interval;
$$;

REVOKE EXECUTE ON FUNCTION event_is_stale(TEXT, TIMESTAMPTZ, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION event_is_stale(TEXT, TIMESTAMPTZ, INT)
  TO anon, authenticated, service_role;
CREATE OR REPLACE VIEW events_public AS
SELECT
  e.id,
  e.name,
  e.content_type,
  e.event_category,
  e.tags,
  e.flyer_style,
  e.date_type,
  e.date_start,
  e.date_end,
  e.time_start,
  e.time_end,
  e.recurrence_rule,
  e.date_raw,
  e.location_name,
  e.location_address,
  e.location_geo,
  e.is_outdoor,
  e.description,
  e.contact,
  e.event_url,
  e.price_raw,
  e.is_free,
  e.age_restriction,
  e.is_public,
  e.language,
  e.accessibility,
  e.masks_required,
  e.rsvp_required,
  e.rsvp_url,
  e.search_text,
  e.confidence_score,
  e.confidence_breakdown,
  e.sighting_count,
  e.first_sighted_at,
  e.last_sighted_at,
  o.name              AS organization_name,
  o.website           AS organization_website,
  v.id                AS venue_id,
  v.name              AS venue_name,
  v.website           AS venue_website,
  v.address           AS venue_address,
  v.geolocation       AS venue_geo,
  v.accessibility     AS venue_accessibility,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',               t.id,
        'name',             t.name,
        'talent_type',      t.talent_type,
        'role',             et.role,
        'billing_position', et.billing_position,
        'confirmed',        et.confirmed
      )
      ORDER BY COALESCE(et.billing_position, 9999)
    ) FILTER (WHERE t.id IS NOT NULL),
    '[]'::jsonb
  ) AS talent,
  e.has_enrichment     -- appended last; use DROP/CREATE if adding further columns
FROM events e
LEFT JOIN organizations o  ON o.id = e.organization_id
LEFT JOIN venues v         ON v.id = e.venue_id
LEFT JOIN event_talent et  ON et.event_id = e.id
LEFT JOIN talent t         ON t.id = et.talent_id
WHERE e.is_active = true
  AND NOT event_is_stale(e.date_type, e.last_sighted_at, e.staleness_days)
  AND e.confidence_score >= (SELECT value::FLOAT FROM config WHERE key = 'min_confidence_display')
GROUP BY e.id, o.name, o.website, v.id, v.name, v.website, v.address, v.geolocation, v.accessibility;