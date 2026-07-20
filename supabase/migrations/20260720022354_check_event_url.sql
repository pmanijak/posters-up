-- URL liveness tracking for event_url / rsvp_url.
--
-- Flyer photos get OCR'd into event_url/rsvp_url, and misreads (1/l, 0/O,
-- dropped path segments) produce plausible-looking but dead links. This
-- adds status tracking so the presentation layer can hide/relabel dead
-- links, without touching the "events holds what the flyer says" principle
-- — the flyer's literal URL string is never modified, only annotated.
--
-- Deliberately decoupled from `enrich`: enrichment only queues events
-- missing a field or under 0.7 confidence, so a well-extracted event with
-- a bad URL would otherwise never get checked. This is a plain HTTP
-- HEAD/GET call with no LLM involvement, so it doesn't need that gate —
-- see supabase/functions/check-urls.
--
-- Status is null until checked. Once checked it holds the actual outcome
-- rather than a collapsed live/dead judgment: a 3-digit HTTP status code
-- as text ('200', '301', '403', '404', '500', ...), or 'timeout' /
-- 'unreachable' for outcomes with no HTTP response at all (DNS failure,
-- connection refused, TLS failure, or the request not completing within
-- the check's timeout). Deciding which codes should read as "broken" to
-- a user (404/410, yes; 403/429/5xx, probably not — those are as often
-- bot-blocking as an actually-gone page) is left to the presentation
-- layer, not baked into this column.

ALTER TABLE events
  ADD COLUMN event_url_status TEXT
    CHECK (event_url_status ~ '^[0-9]{3}$' OR event_url_status IN ('timeout', 'unreachable')),
  ADD COLUMN event_url_checked_at TIMESTAMPTZ,
  ADD COLUMN rsvp_url_status TEXT
    CHECK (rsvp_url_status ~ '^[0-9]{3}$' OR rsvp_url_status IN ('timeout', 'unreachable')),
  ADD COLUMN rsvp_url_checked_at TIMESTAMPTZ;

COMMENT ON COLUMN events.event_url_status IS
  'Result of the last check-urls request against event_url: a 3-digit HTTP status code as text, or ''timeout''/''unreachable'' for non-HTTP failures. Null = unchecked or not applicable. Set by check-urls, never by enrich.';
COMMENT ON COLUMN events.rsvp_url_status IS
  'Result of the last check-urls request against rsvp_url. Same semantics as event_url_status. Null also covers the case where rsvp_url is an email address, not a URL.';

-- events_public needs the two status columns appended. Dependent
-- SETOF events_public functions must be dropped first (see the
-- "appended last" comment on the view's has_enrichment column).

DROP FUNCTION IF EXISTS events_for_boards(uuid[]);
DROP FUNCTION IF EXISTS search_events_semantic(vector, float, int);
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
        'billing_position', et.billing_position,
        'confirmed',        et.confirmed
      )
      ORDER BY COALESCE(et.billing_position, 9999)
    ) FILTER (WHERE t.id IS NOT NULL),
    '[]'::jsonb
  ) AS talent,
  e.has_enrichment,
  e.event_url_status,  -- appended: use DROP/CREATE if adding further columns
  e.rsvp_url_status     -- appended: use DROP/CREATE if adding further columns
FROM events e
LEFT JOIN organizations o  ON o.id = e.organization_id
LEFT JOIN venues v         ON v.id = e.venue_id
LEFT JOIN event_talent et  ON et.event_id = e.id
LEFT JOIN talent t         ON t.id = et.talent_id
WHERE e.is_active = true
  AND NOT event_is_stale(e.date_type, e.last_sighted_at, e.staleness_days)
  AND e.confidence_score >= (SELECT value::FLOAT FROM config WHERE key = 'min_confidence_display')
GROUP BY e.id, o.name, o.website, v.id, v.name, v.website, v.address, v.geolocation, v.accessibility;

GRANT SELECT ON events_public TO anon, authenticated, service_role;

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

GRANT EXECUTE ON FUNCTION events_for_boards(uuid[]) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION search_events_semantic(
  query_embedding  vector,
  match_threshold  float DEFAULT 0.3,
  match_count      int   DEFAULT 50
)
RETURNS SETOF events_public
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT ep.*
  FROM events_public ep
  JOIN events e ON e.id = ep.id
  WHERE e.embedding IS NOT NULL
    AND 1 - (e.embedding <=> query_embedding) >= match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION search_events_semantic(vector, float, int) TO anon, authenticated, service_role;

-- Recheck cadence, in the same config table pattern used elsewhere
-- (see confidence_weight_* / trust weight rows in schema_current.sql).
INSERT INTO config (key, value, description) VALUES
  ('url_recheck_interval_days', '14', 'check-urls: minimum days between rechecks of an already-checked event_url/rsvp_url')
ON CONFLICT (key) DO NOTHING;