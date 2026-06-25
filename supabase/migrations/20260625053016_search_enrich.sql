-- Migration: include enrichment narrative in search_text
--
-- Adds description, talent bios, and venue_context from enrichment_data
-- to the generated search text. Uses the same sighting selection as
-- tell-me-more: most recent sighting with non-null enrichment_data.
--
-- After deploying, run the backfill:
--   SELECT compute_event_confidence(id) FROM events WHERE is_active = true;
-- (compute_event_confidence calls generate_search_text, so one pass does both)

CREATE OR REPLACE FUNCTION generate_search_text(p_event_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  e                     events%ROWTYPE;
  talent_summary        TEXT;
  date_summary          TEXT;
  time_summary          TEXT;
  enrichment_desc       TEXT;
  enrichment_talent     TEXT;
  enrichment_venue      TEXT;
  result                TEXT;
BEGIN
  SELECT * INTO e FROM events WHERE id = p_event_id;

  -- Talent billed on the event (from flyer extraction)
  SELECT string_agg(
    CASE
      WHEN et.role IS NOT NULL THEN t.name || ' (' || et.role || ')'
      ELSE t.name
    END,
    ', '
    ORDER BY COALESCE(et.billing_position, 999)
  )
  INTO talent_summary
  FROM event_talent et
  JOIN talent t ON t.id = et.talent_id
  WHERE et.event_id = p_event_id;

  date_summary := CASE e.date_type
    WHEN 'specific'    THEN to_char(e.date_start, 'Day Mon DD')
    WHEN 'recurring'   THEN COALESCE(e.date_raw, 'recurring')
    WHEN 'approximate' THEN e.date_raw
    ELSE NULL
  END;

  time_summary := CASE
    WHEN e.time_start IS NOT NULL AND e.time_end IS NOT NULL
      THEN to_char(e.time_start, 'HH12:MI AM') || ' – ' || to_char(e.time_end, 'HH12:MI AM')
    WHEN e.time_start IS NOT NULL
      THEN to_char(e.time_start, 'HH12:MI AM')
    ELSE NULL
  END;

  -- Enrichment narrative — most recent sighting with non-null enrichment_data,
  -- matching the selection logic in tell-me-more/route.ts.
  SELECT
    es.enrichment_data->>'description',
    (
      -- Concatenate name + bio for each talent entry.
      -- nullif prevents empty-string entries when bio is absent.
      SELECT string_agg(
        nullif(
          trim(
            coalesce(t_entry->>'name', '') ||
            CASE WHEN t_entry->>'bio' IS NOT NULL
                 THEN ' ' || (t_entry->>'bio')
                 ELSE ''
            END
          ),
          ''
        ),
        ' '
      )
      FROM jsonb_array_elements(es.enrichment_data->'talent') AS t_entry
    ),
    es.enrichment_data->>'venue_context'
  INTO enrichment_desc, enrichment_talent, enrichment_venue
  FROM event_sightings es
  WHERE es.event_id = p_event_id
    AND es.enrichment_data IS NOT NULL
  ORDER BY es.sighted_at DESC
  LIMIT 1;

  result := concat_ws(' ',
    e.name,                          -- name first for search relevance
    e.event_category,
    talent_summary,
    concat_ws(' at ',
      concat_ws(', ', date_summary, time_summary),
      e.location_name
    ),
    concat_ws(', ',
      e.age_restriction,
      e.price_raw,
      CASE WHEN e.language IS NOT NULL AND e.language <> 'en'
           THEN 'language: ' || e.language ELSE NULL END,
      CASE WHEN e.is_outdoor = true  THEN 'outdoor' ELSE NULL END,
      CASE WHEN e.is_outdoor = false THEN 'indoor'  ELSE NULL END
    ),
    e.description,
    CASE WHEN e.tags IS NOT NULL THEN array_to_string(e.tags, ', ') ELSE NULL END,
    concat_ws(', ',
      CASE WHEN e.accessibility IS NOT NULL
           THEN array_to_string(e.accessibility, ', ') ELSE NULL END,
      CASE WHEN e.masks_required IS NOT NULL
           THEN 'masks: ' || e.masks_required ELSE NULL END
    ),
    -- Enrichment narrative appended last — supplements flyer text,
    -- never replaces it. Null-safe: concat_ws skips nulls.
    enrichment_desc,
    enrichment_talent,
    enrichment_venue
  );

  UPDATE events
  SET search_text = result, updated_at = now()
  WHERE id = p_event_id;

  RETURN result;
END;
$$;