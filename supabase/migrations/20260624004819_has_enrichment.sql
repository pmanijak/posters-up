-- ============================================================
-- Migration: add has_enrichment flag to events
--
-- Allows the event card to show the correct button label
-- ("Tell me more" vs "Find this poster") from initial page load
-- without waiting for the tell-me-more API call.
--
-- Set to true by the enrich function when it writes narrative
-- content (description, talent bios, venue context).
-- Never set by extract — extraction confidence is separate.
-- ============================================================

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS has_enrichment BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN events.has_enrichment IS
  'True when the enrich function has written narrative content '
  '(description, talent bios, or venue context) to enrichment_data. '
  'Used by the event card to choose the correct expansion label '
  'without a round-trip to the tell-me-more API.';

-- Backfill for events that already have new-format enrichment data.
-- Detects new format by presence of top-level description/talent/venue_context keys.
UPDATE events e
SET has_enrichment = TRUE
WHERE EXISTS (
  SELECT 1
  FROM event_sightings es
  WHERE es.event_id = e.id
    AND es.enrichment_data IS NOT NULL
    AND (
      es.enrichment_data ? 'description'   OR
      es.enrichment_data ? 'talent'        OR
      es.enrichment_data ? 'venue_context'
    )
);

-- Update events_public to expose has_enrichment.
-- events_for_boards() returns SETOF events_public so it must be dropped first,
-- then recreated after the view. Grants are re-applied on both.
DROP FUNCTION IF EXISTS events_for_boards(uuid[]);
DROP VIEW IF EXISTS events_public;

CREATE VIEW events_public AS
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
        'billing_position', et.billing_position
      )
      ORDER BY COALESCE(et.billing_position, 9999)
    ) FILTER (WHERE t.id IS NOT NULL),
    '[]'::jsonb
  ) AS talent,
  e.has_enrichment
FROM events e
LEFT JOIN organizations o  ON o.id = e.organization_id
LEFT JOIN venues v         ON v.id = e.venue_id
LEFT JOIN event_talent et  ON et.event_id = e.id
LEFT JOIN talent t         ON t.id = et.talent_id
WHERE e.is_active = true
  AND e.confidence_score >= (SELECT value::FLOAT FROM config WHERE key = 'min_confidence_display')
GROUP BY e.id, o.name, o.website, v.id, v.name, v.website, v.address, v.geolocation, v.accessibility;

CREATE OR REPLACE FUNCTION events_for_boards(board_ids uuid[])
RETURNS SETOF events_public
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT ep.*
  FROM events_public ep
  WHERE ep.id IN (
    SELECT event_id
    FROM board_flyers
    WHERE board_id = ANY(board_ids)
      AND is_active = true
  );
$$;

GRANT SELECT ON events_public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION events_for_boards(uuid[]) TO anon, authenticated, service_role;