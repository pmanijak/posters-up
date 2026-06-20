-- Migration: boards_near_detail
-- Returns boards within radius, sorted by fuzzy relevance score:
--   active_flyer_count / sqrt(max(distance_m, 10))
--
-- popular_tags: the 8 most-used tags across active events on the board,
--   ordered by frequency. Powers the tag chips on board cards.
--
-- primary_category: the most common event_category among active events.
--   Used by the presentation layer for accent color, matching event-card
--   visual language.

DROP FUNCTION IF EXISTS boards_near_detail(float, float, int);

CREATE FUNCTION boards_near_detail(
  lat      float,
  lng      float,
  radius_m int DEFAULT 10000
)
RETURNS TABLE (
  id                           uuid,
  location_name                text,
  description                  text,
  managed_by                   text,
  requires_entry_to_photograph boolean,
  requires_entry_to_post       boolean,
  last_sighted_at              timestamptz,
  active_flyer_count           bigint,
  popular_tags                 text[],
  primary_category             text,
  distance_m                   float,
  relevance_score              float,
  board_lat                    float,
  board_lng                    float
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    bp.id,
    bp.location_name,
    bp.description,
    bp.managed_by,
    bp.requires_entry_to_photograph,
    bp.requires_entry_to_post,
    bp.last_sighted_at,
    bp.active_flyer_count,

    -- Top 8 tags by frequency across active events on this board
    ARRAY(
      SELECT tag
      FROM (
        SELECT unnest(e.tags) AS tag, COUNT(*) AS freq
        FROM board_flyers bf2
        JOIN events e ON e.id = bf2.event_id
        WHERE bf2.board_id = bp.id
          AND bf2.is_active = true
          AND e.is_active  = true
        GROUP BY tag
        ORDER BY freq DESC
        LIMIT 8
      ) t
    ) AS popular_tags,

    -- Most common event_category among active events on this board
    (
      SELECT e.event_category
      FROM board_flyers bf2
      JOIN events e ON e.id = bf2.event_id
      WHERE bf2.board_id        = bp.id
        AND bf2.is_active       = true
        AND e.is_active         = true
        AND e.event_category IS NOT NULL
      GROUP BY e.event_category
      ORDER BY COUNT(*) DESC
      LIMIT 1
    ) AS primary_category,

    ST_Distance(
      bp.geolocation::geography,
      ST_MakePoint(lng, lat)::geography
    )                                                                        AS distance_m,
    bp.active_flyer_count::float /
      SQRT(GREATEST(
        ST_Distance(bp.geolocation::geography, ST_MakePoint(lng, lat)::geography),
        10.0
      ))                                                                     AS relevance_score,
    ST_Y(bp.geolocation::geometry)                                           AS board_lat,
    ST_X(bp.geolocation::geometry)                                           AS board_lng
  FROM boards_public bp
  WHERE ST_DWithin(
    bp.geolocation::geography,
    ST_MakePoint(lng, lat)::geography,
    radius_m
  )
  ORDER BY relevance_score DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION boards_near_detail TO anon;