-- ============================================================
-- Bulletin Board Event Database Schema
-- PostgreSQL + PostGIS
-- Version 7 — Discovery metadata, accessibility, plain-language query support
-- ============================================================
-- Design principles:
--   - Living database, not an archive
--   - Everything expires via unsighted logic
--   - Confidence is a computed score with three independent inputs:
--       extraction    (what the AI read from the photo)
--       sightings     (how many independent BOARDS showed this event —
--                      not how many times any one board was photographed)
--       verification  (what web sources confirmed it)
--   - Confidence measures reliability of what we know, not how much we know.
--     A sparse flyer that was read perfectly is not a low-confidence event.
--   - Flyer style is a separate signal from confidence.
--     It describes the character of the flyer, not the quality of the extraction.
--     Minimal flyers are presented differently, not penalized.
--   - Photos are short-lived; the knowledge they produce is not
--   - Board locations are long-lived but can be deleted when genuinely gone;
--     prefer is_active = false for temporary closures
--   - A board has logical state: which flyers are currently on it
--   - Human moderation is an exception handler, not a pipeline stage
--   - Venues, organizations, and talent are three distinct entity types:
--       venues        — physical spaces that host events (Obsidian, the library)
--       organizations — promoters/organizers who run events (not the space, not the act)
--       talent        — performers, speakers, artists, filmmakers, facilitators, etc.
--   - Talent vocabulary is content-type-agnostic:
--       talent_type   describes what kind of person/act this is
--       role          describes what they're doing at this specific event (free text)
--       billing_position captures prominence on the flyer (1 = top of bill)
--       "headliner/support/opener" is just one vocabulary among many
--   - Follows are generalized: users can follow talent, venues, or orgs
--       exactly one follow target per row; enforced by CHECK + partial unique indexes
--   - Admission price is preserved verbatim from the flyer (never normalized)
--       is_free is a derived boolean for filtering
--   - Discovery metadata enriches structured browse AND plain-language queries:
--       event_category — primary type for filtering ('music', 'workshop', 'market'...)
--       tags           — AI-extracted labels for soft matching and facets
--       age_restriction, accessibility, masks_required — hard filters that matter
--       is_outdoor, language, is_public — audience and environment signals
--   - Plain-language query is a first-class feature, not a future add-on:
--       search_text    — pipeline-generated human-readable summary, always current
--       embedding      — pgvector embedding of search_text for semantic retrieval
--       query flow: hard filters → SQL, soft preferences → ANN on embedding,
--                   ranking and explanation → Claude
--   - Venue accessibility is permanent and comes from web enrichment;
--     event accessibility overrides/supplements it per-event
-- ============================================================
 
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector; native in Supabase
 
 
-- ============================================================
-- PERMANENT
-- ============================================================
 
-- Physical bulletin board locations.
-- These are community infrastructure — kept indefinitely.
-- Marked inactive via unsighted logic (long window, see config).
-- Note: a board at a venue is not the same as a venue.
-- A board outside Obsidian has board_type='venue'; it does not
-- reference the venues table. The board is infrastructure;
-- the venue is a named entity that hosts events.
CREATE TABLE boards (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  geolocation             GEOGRAPHY(POINT, 4326) NOT NULL,
 
  -- Human-readable location hint for navigation.
  -- Should be specific enough to find the board without GPS:
  -- "Outside Rainy Day Records on 4th Ave, next to the front door"
  -- not just "Rainy Day Records".
  -- This is what the app shows when directing a user to visit the board in person.
  description             TEXT,
 
  -- Physical character of this board
  board_type              TEXT,
                          -- 'coffee_shop', 'record_store', 'library',
                          -- 'community_center', 'laundromat', 'university',
                          -- 'venue', 'grocery', 'other'
  managed_by              TEXT,        -- free text: who owns/manages the board
  posting_policy          TEXT,        -- human-readable rules for this board
 
  -- Content restrictions set by the board owner.
  -- null = all content types allowed.
  -- Non-null = only listed content_type values are permitted.
  -- Used during extraction to flag out-of-policy flyers.
  -- e.g. ARRAY['event', 'announcement']
  allowed_content_types   TEXT[],
 
  -- Most recent photo that produced a full extraction of this board's state.
  -- Used to provide prior context to the extraction prompt:
  -- "these events were known on this board as of last photo."
  -- Helps the AI focus attention and improves extraction quality.
  -- Not used for cost optimization — every photo still gets extracted.
  current_state_photo_id  UUID,        -- FK added below after photos table
 
  first_sighted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sighted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active               BOOLEAN     NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
 
CREATE INDEX idx_boards_geo        ON boards USING GIST(geolocation);
CREATE INDEX idx_boards_last_seen  ON boards(last_sighted_at);
CREATE INDEX idx_boards_active     ON boards(is_active);
CREATE INDEX idx_boards_type       ON boards(board_type);
CREATE INDEX idx_boards_content    ON boards USING GIN(allowed_content_types);
 
 
-- Promoters and community groups that organize events.
-- Distinct from venues (who host) and talent (who perform).
-- "The organizer" is whoever is responsible for the event happening —
-- the booker, the community group, the fundraiser committee.
-- Emerges organically from extraction — never manually entered.
-- Expires when they have no active events for a long time.
CREATE TABLE organizations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  canonical_name  TEXT        NOT NULL,    -- normalized for dedup matching
  website         TEXT,
  phone           TEXT,
  email           TEXT,
  description     TEXT,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at  TIMESTAMPTZ,             -- bumped when any of their events are sighted
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
 
CREATE INDEX idx_orgs_canonical ON organizations(canonical_name);
 
 
-- Physical spaces that host events on a recurring basis.
-- Distinct from boards (which are posting infrastructure) and
-- from the raw location fields on events (which are extracted text).
-- A venue is a named entity: Obsidian, the Olympia Library, Traditions Café.
-- Emerges organically — created when extraction or web enrichment
-- resolves an event location to a known recurring host.
-- events.venue_id is set during enrichment when a match is found;
-- the raw location_name/location_address fields are always preserved.
--
-- Future pipeline extension: venue websites are the highest-trust
-- verification source (trust_weight = 0.90). The natural next step
-- is ingesting events directly from venue calendars — not just using
-- venue sites for verification, but as a primary source. When that
-- pipeline is built, events will need a source_type to distinguish
-- board-extracted from venue-calendar-ingested.
CREATE TABLE venues (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  canonical_name  TEXT        NOT NULL,    -- normalized for dedup matching
  address         TEXT,
  geolocation     GEOGRAPHY(POINT, 4326),
  website         TEXT,
  description     TEXT,
  venue_type      TEXT,
                  -- 'music_venue', 'bar', 'coffee_shop', 'library',
                  -- 'community_center', 'gallery', 'theater', 'outdoor',
                  -- 'university', 'religious', 'other'
 
  -- Permanent physical accessibility of this venue.
  -- Comes from web enrichment (venue website, Google Maps, disability resources),
  -- not from flyers. Event-level overrides live on events.accessibility.
  -- e.g. ARRAY['wheelchair', 'elevator', 'gender_neutral_restroom', 'hearing_loop']
  accessibility   TEXT[],
 
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at  TIMESTAMPTZ,             -- bumped when any of their events are sighted
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
 
CREATE INDEX idx_venues_geo       ON venues USING GIST(geolocation);
CREATE INDEX idx_venues_canonical ON venues(canonical_name);
CREATE INDEX idx_venues_active    ON venues(is_active);
CREATE INDEX idx_venues_type      ON venues(venue_type);
 
 
-- Performers, speakers, artists, filmmakers, facilitators — anyone billed on a flyer.
-- Distinct from organizations (who run events) and venues (who host them).
-- The Gobs play a show — they didn't book it, and they're not the venue.
-- Emerges organically from extraction — the AI reads billing from the flyer.
-- Many-to-many with events via event_talent.
-- Local talent accumulates sightings naturally over time; the is_local
-- distinction is left to emerge from sighting patterns rather than being
-- set manually. A band that appears on Olympia boards repeatedly is local
-- by behavior, not by flag.
--
-- talent_type describes what kind of entity this is — used by the UI
-- to label and present them appropriately ("performing", "speaking",
-- "exhibiting", etc.) without a content_type lookup on every render.
-- AI-assessed at extraction time; can be corrected manually.
CREATE TABLE talent (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  canonical_name  TEXT        NOT NULL,    -- normalized for dedup matching
  talent_type     TEXT,
                  -- 'act'         - musical act, band, solo artist, DJ
                  -- 'speaker'     - presenter, lecturer, panelist, moderator
                  -- 'artist'      - visual artist, exhibiting creator
                  -- 'filmmaker'   - director, screenwriter, producer
                  -- 'facilitator' - workshop leader, class instructor, host
                  -- 'comedian'    - stand-up, improv, sketch performer
                  -- 'other'       - anything not covered above
                  -- null          - not yet classified
  description     TEXT,
  website         TEXT,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at  TIMESTAMPTZ,             -- bumped when any of their events are sighted
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
 
CREATE INDEX idx_talent_canonical ON talent(canonical_name);
CREATE INDEX idx_talent_active    ON talent(is_active);
 
 
-- Contributors — anyone who submits photos.
-- Managed by Supabase Auth; this table mirrors the auth.users UUID
-- so the rest of the schema can reference it with a proper foreign key.
-- Kept minimal by design: no profiles, no social features, no reputation layer.
-- Purpose is cost protection (rate limiting) and abuse accountability,
-- not identity. Email is the only PII stored here.
-- ON DELETE SET NULL on referencing tables means a deleted user's
-- photos and reports are anonymized but not lost.
CREATE TABLE users (
  id              UUID        PRIMARY KEY,  -- mirrors Supabase auth.users.id
  email           TEXT        NOT NULL UNIQUE,
  is_active       BOOLEAN     NOT NULL DEFAULT true,  -- set false to ban
  last_active_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
 
CREATE INDEX idx_users_email ON users(email);
 
 
-- Follows — subscriptions for push notifications.
-- Users can follow talent, venues, or orgs. Exactly one target per row.
-- This is the push-notification subscription model:
--   talent follow: "notify me when The Gobs have a new event"
--   venue follow:  "notify me when Obsidian posts something new"
--   org follow:    "notify me when the Olympia Film Society is next"
-- The notification mechanism itself is a future concern.
-- Permanent while both the user and the followed entity are active.
--
-- Constraint design: a CHECK ensures exactly one target is set.
-- Partial unique indexes (instead of a composite UNIQUE constraint)
-- prevent duplicate follows per target type without conflating NULLs.
CREATE TABLE follows (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
 
  -- Exactly one of these must be non-null.
  talent_id   UUID        REFERENCES talent(id)        ON DELETE CASCADE,
  venue_id    UUID        REFERENCES venues(id)         ON DELETE CASCADE,
  org_id      UUID        REFERENCES organizations(id)  ON DELETE CASCADE,
 
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
 
  -- Enforce exactly one target per row.
  CONSTRAINT follows_one_target CHECK (
    (talent_id IS NOT NULL)::INT +
    (venue_id  IS NOT NULL)::INT +
    (org_id    IS NOT NULL)::INT = 1
  )
);
 
-- One follow per user per target (partial indexes exclude NULLs correctly).
CREATE UNIQUE INDEX idx_follows_user_talent ON follows(user_id, talent_id) WHERE talent_id IS NOT NULL;
CREATE UNIQUE INDEX idx_follows_user_venue  ON follows(user_id, venue_id)  WHERE venue_id  IS NOT NULL;
CREATE UNIQUE INDEX idx_follows_user_org    ON follows(user_id, org_id)    WHERE org_id    IS NOT NULL;
 
CREATE INDEX idx_follows_user   ON follows(user_id);
CREATE INDEX idx_follows_talent ON follows(talent_id) WHERE talent_id IS NOT NULL;
CREATE INDEX idx_follows_venue  ON follows(venue_id)  WHERE venue_id  IS NOT NULL;
CREATE INDEX idx_follows_org    ON follows(org_id)    WHERE org_id    IS NOT NULL;
 
 
-- ============================================================
-- MEDIUM-LIVED (weeks to months)
-- ============================================================
 
-- Canonical deduplicated events.
-- One record per real-world event, regardless of how many boards
-- or photos it was extracted from.
-- Expires automatically via date or unsighted logic.
CREATE TABLE events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  organization_id  UUID        REFERENCES organizations(id) ON DELETE SET NULL,
 
  -- The venue where this event is being held.
  -- Set during enrichment when the extracted location matches a known venue.
  -- Null is normal — not every event is at a recurring host space,
  -- and not every venue has been seen before.
  -- The raw location fields below are always preserved regardless.
  venue_id         UUID        REFERENCES venues(id) ON DELETE SET NULL,
 
  -- What kind of content is this?
  -- Not everything on a board is an event.
  content_type     TEXT        NOT NULL DEFAULT 'event',
                   -- 'event'        - a thing happening at a time and place
                   -- 'announcement' - general news or notice
                   -- 'resource'     - ongoing service (clinic, support group)
                   -- 'seeking'      - band seeking space, volunteers needed, etc.
                   -- 'advocacy'     - political/cause flyer
 
  -- Date and time
  -- date_type drives which other fields are meaningful.
  date_type        TEXT        NOT NULL DEFAULT 'specific',
                   -- 'specific'    - exact date known (date_start required)
                   -- 'recurring'   - repeating pattern (recurrence_rule required)
                   -- 'approximate' - rough date known (date_raw captures original text)
                   -- 'unknown'     - no date info available
  date_start       DATE,
  date_end         DATE,
  time_start       TIME,
  time_end         TIME,
  recurrence_rule  TEXT,        -- RRULE string e.g. "FREQ=WEEKLY;BYDAY=WE"
  date_raw         TEXT,        -- original string as extracted e.g. "every 3rd Saturday"
 
  -- Event location as extracted from the flyer.
  -- Always preserved verbatim. venue_id above is the structured reference
  -- when the location matches a known venue; these fields are the raw source.
  location_name    TEXT,
  location_address TEXT,
  location_geo     GEOGRAPHY(POINT, 4326),
 
  -- Content
  description      TEXT,
 
  -- Public-facing contact: venue website, booking page, or org link.
  -- NEVER a personal phone number or personal email extracted from a flyer.
  -- Personal contacts stay in event_sightings.raw_extraction only — they are
  -- not promoted here. The pipeline must strip or suppress personal contact
  -- patterns (mobile numbers, personal email addresses) before writing this field.
  -- The app is a discovery layer: where a web presence exists, point there.
  -- Do not replicate venue data — link to it.
  contact          TEXT,
 
  -- Specific URL for this event: QR code destination, Eventbrite listing,
  -- Facebook event, or dedicated page. Distinct from contact (which is the
  -- organizer's general presence) — this points to this event specifically.
  -- Also the primary input for the verification pipeline's URL-match dedup.
  event_url        TEXT,
 
  -- Admission price as extracted verbatim from the flyer.
  -- Never normalize — flyers use many formats and precision matters:
  -- "free", "$10", "$5–15 sliding scale", "suggested donation $5",
  -- "PWYW", "free with RSVP", "$12 adv / $15 door".
  -- Normalization loses information; preserve what the flyer says.
  -- is_free is a derived boolean for filtering and display badges;
  -- set by the pipeline when price_raw is null or clearly free.
  -- Both fields null = admission info not present on the flyer.
  price_raw        TEXT,
  is_free          BOOLEAN,
 
  -- -------------------------------------------------------
  -- DISCOVERY METADATA
  -- AI-extracted during the sighting pass. Many of these fields
  -- can be inferred from flyer content even without explicit labels.
  -- -------------------------------------------------------
 
  -- Primary category for filtering and browse.
  -- Single value — the most accurate description of what this event is.
  event_category   TEXT,
                   -- 'music'            - concert, show, open mic, DJ night
                   -- 'film'             - screening, festival, documentary
                   -- 'theater'          - play, improv, musical, performance art
                   -- 'dance'            - performance or social dancing (contra, swing...)
                   -- 'comedy'           - stand-up, sketch, improv
                   -- 'spoken_word'      - poetry, storytelling, reading
                   -- 'visual_art'       - opening, gallery show, studio tour
                   -- 'market'           - farmers market, craft fair, flea market
                   -- 'lecture'          - talk, presentation, panel, symposium
                   -- 'workshop'         - participatory skill-building session
                   -- 'fitness'          - yoga, run, class, sport
                   -- 'community'        - meeting, town hall, neighborhood event
                   -- 'support_group'    - recurring peer support (AA, grief, etc.)
                   -- 'fundraiser'       - benefit show, auction, bake sale
                   -- 'party'            - social gathering, celebration
                   -- 'other'            - doesn't fit above
                   -- null               - not yet categorized
 
  -- Additional searchable labels. AI-extracted from flyer content.
  -- Used for soft matching in plain-language queries and faceted browse.
  -- Genre tags ('punk', 'jazz', 'folk'), audience tags ('queer', 'family'),
  -- format tags ('benefit', 'potluck', 'outdoor'), topic tags ('climate',
  -- 'housing'), etc. No controlled vocabulary — let them emerge.
  tags             TEXT[],
 
  -- -------------------------------------------------------
  -- AUDIENCE
  -- -------------------------------------------------------
 
  -- Legal/venue age restriction. Distinct from family-friendliness.
  -- '21+' and '18+' are legal constraints; 'all_ages' is an explicit
  -- inclusion signal; 'family' means children are welcome and expected.
  -- null = not specified on the flyer.
  age_restriction  TEXT,
                   -- 'all_ages', 'family', '18+', '21+', null
 
  -- Whether this is an open public event or restricted access.
  -- Most board-sourced events are public by definition.
  -- false covers: members-only, invite-only, RSVP-required-for-entry.
  -- null = not specified (assume public for board-sourced events).
  is_public        BOOLEAN,
 
  -- Primary language the event will be conducted in.
  -- BCP 47 code. null = not specified (English assumed for US boards).
  -- Populated when the flyer is in another language or explicitly states
  -- the event language (e.g. "Reunión en español").
  language         TEXT,
 
  -- -------------------------------------------------------
  -- ENVIRONMENT
  -- -------------------------------------------------------
 
  is_outdoor       BOOLEAN,    -- null = not specified or indeterminate
 
  -- -------------------------------------------------------
  -- ACCESSIBILITY (event-level)
  -- Supplements or overrides venues.accessibility for this specific event.
  -- Sourced from the flyer; web enrichment may add to it.
  -- Common values: 'wheelchair', 'asl', 'gender_neutral_restroom',
  --   'no_one_turned_away', 'sliding_scale', 'sober', 'fragrance_free'
  -- -------------------------------------------------------
 
  accessibility    TEXT[],
 
  -- Masks policy gets its own field because it is a hard filter
  -- for a significant portion of users and has temporal character
  -- (it can change event-to-event even at the same venue).
  masks_required   TEXT,
                   -- 'required', 'recommended', 'optional', 'not_required', null
 
  -- -------------------------------------------------------
  -- REGISTRATION
  -- -------------------------------------------------------
 
  rsvp_required    BOOLEAN,    -- null = not specified
  rsvp_url         TEXT,       -- link to RSVP form; may differ from event_url
 
  -- -------------------------------------------------------
  -- PLAIN-LANGUAGE QUERY SUPPORT
  -- Both fields are pipeline-generated. Never set manually.
  -- Regenerated by generate_search_text() whenever the event is
  -- meaningfully updated (new sighting, enrichment, confidence recompute).
  -- -------------------------------------------------------
 
  -- Human-readable summary of everything known about this event.
  -- Template: "{category}. {talent}. {date} at {location}, {age}, {price}.
  --            {description}. {tags}. {accessibility}."
  -- Optimized for embedding quality: most discriminating info first.
  -- Also used for Postgres full-text search on the free query path.
  search_text      TEXT,
 
  -- Semantic embedding of search_text.
  -- Model: text-embedding-3-small, 1536 dimensions (OpenAI).
  -- Generated asynchronously after a sighting reaches auto_approved status.
  -- Indexed with HNSW for approximate nearest-neighbor search.
  -- Query flow: hard filters → SQL → ANN on embedding → Claude reranks.
  embedding        vector(1536),
 
  -- Flyer character, derived from sightings by compute_event_confidence().
  -- This is NOT a quality signal. It describes the kind of flyer this is,
  -- and drives how the event is presented, not whether it is presented.
  -- See event_sightings.flyer_style for full value descriptions.
  flyer_style      TEXT,
 
  -- Confidence measures how reliably we read what the flyer says.
  -- It does NOT measure how much information the flyer contains.
  -- A minimal flyer read perfectly has high confidence and sparse fields —
  -- that is correct behavior, not a failure.
  --
  -- Computed automatically from three sources.
  -- Never set manually — always written by compute_event_confidence().
  -- 0.0 = unknown, 1.0 = confirmed by many independent sources + web
  confidence_score     FLOAT   NOT NULL DEFAULT 0.0,
  confidence_breakdown JSONB,
  -- e.g. {
  --   "extraction":    0.82,   -- avg AI confidence across non-rejected sightings
  --   "sighting":      0.78,   -- diminishing-returns curve on distinct board count
  --   "board_count":   3,      -- number of distinct boards showing this event
  --   "verification":  0.90,   -- probabilistic combination of source trust weights
  --   "flyer_style":   "minimal",
  --   "sources": [
  --     "https://theolympian.com/events/dragon-boat-2024",
  --     "https://eventbrite.com/e/..."
  --   ],
  --   "computed_at": "2024-06-01T04:00:00Z"
  -- }
 
  sighting_count   INT         NOT NULL DEFAULT 0,
                   -- number of distinct boards that have shown this event;
                   -- multiple photos of the same board count as one.
  first_sighted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sighted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
 
  -- Expiry
  -- expires_at: null for recurring/unknown events; set from date_end or date_start
  -- staleness_days: null = use global config value
  expires_at       TIMESTAMPTZ,
  staleness_days   INT,
  is_active        BOOLEAN     NOT NULL DEFAULT true,
 
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
 
CREATE INDEX idx_events_geo          ON events USING GIST(location_geo);
CREATE INDEX idx_events_last_sighted ON events(last_sighted_at);
CREATE INDEX idx_events_expires      ON events(expires_at);
CREATE INDEX idx_events_active       ON events(is_active);
CREATE INDEX idx_events_org          ON events(organization_id);
CREATE INDEX idx_events_venue        ON events(venue_id);
CREATE INDEX idx_events_content_type ON events(content_type);
CREATE INDEX idx_events_confidence   ON events(confidence_score);
CREATE INDEX idx_events_flyer_style  ON events(flyer_style);
CREATE INDEX idx_events_free         ON events(is_free)          WHERE is_free IS NOT NULL;
CREATE INDEX idx_events_category     ON events(event_category)   WHERE event_category IS NOT NULL;
CREATE INDEX idx_events_tags         ON events USING GIN(tags);
CREATE INDEX idx_events_age          ON events(age_restriction)  WHERE age_restriction IS NOT NULL;
CREATE INDEX idx_events_outdoor      ON events(is_outdoor)       WHERE is_outdoor IS NOT NULL;
CREATE INDEX idx_events_language     ON events(language)         WHERE language IS NOT NULL;
CREATE INDEX idx_events_masks        ON events(masks_required)   WHERE masks_required IS NOT NULL;
CREATE INDEX idx_events_public       ON events(is_public)        WHERE is_public IS NOT NULL;
CREATE INDEX idx_events_accessibility ON events USING GIN(accessibility);
 
-- HNSW index for approximate nearest-neighbor search on embeddings.
-- cosine distance is standard for text embeddings.
-- ef_construction=128 and m=16 are good defaults for this scale;
-- tune upward if recall degrades at higher event counts.
CREATE INDEX idx_events_embedding    ON events USING hnsw(embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);
 
 
-- Talent billed for an event.
-- One row per event/talent pair. Role and billing_position are on this row
-- because they describe the relationship, not the talent itself.
-- Emerges from extraction — the AI reads "The Gobs / Cherry Cheeks / Adhesive"
-- and produces three rows, with role and position inferred from flyer layout.
--
-- role is AI-extracted free text. Common values vary by content_type:
--   music show:  'headliner', 'support', 'opener', 'performer', 'dj'
--   talk/panel:  'keynote', 'speaker', 'panelist', 'moderator'
--   film:        'director', 'screenwriter', 'q&a_guest'
--   workshop:    'facilitator', 'co-facilitator', 'instructor'
--   art show:    'exhibiting_artist'
-- Null if the flyer lists the name without describing the role.
--
-- billing_position captures prominence on the flyer: 1 = top of bill.
-- Inferred from visual hierarchy (font size, order, layout) where possible.
-- Null if position is not determinable or not meaningful for this event type.
CREATE TABLE event_talent (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID        NOT NULL REFERENCES events(id)  ON DELETE CASCADE,
  talent_id        UUID        NOT NULL REFERENCES talent(id)  ON DELETE CASCADE,
  role             TEXT,
                   -- AI-extracted free text; see common values above.
                   -- null = name present on flyer but role not described
  billing_position INT,
                   -- 1 = top of bill / most prominent
                   -- null = position not determinable or not applicable
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, talent_id)
);
 
CREATE INDEX idx_event_talent_event  ON event_talent(event_id);
CREATE INDEX idx_event_talent_talent ON event_talent(talent_id);
 
 
-- ============================================================
-- SHORT-LIVED (days to weeks)
-- ============================================================
 
-- Photos submitted by contributors.
-- The image itself is deleted after extraction + review.
-- This record is kept a little longer for audit purposes,
-- then also deleted.
CREATE TABLE photos (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id            UUID        REFERENCES boards(id) ON DELETE SET NULL,
  submitted_by        UUID        REFERENCES users(id)  ON DELETE SET NULL,
  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
 
  -- Link to the previous photo of this same board.
  -- Allows the pipeline to pass prior board state to the extraction prompt
  -- so the AI has context about what was already known.
  previous_photo_id   UUID        REFERENCES photos(id) ON DELETE SET NULL,
 
  -- Image storage
  image_url           TEXT,                    -- null after deletion
  image_deleted_at    TIMESTAMPTZ,
  delete_after        TIMESTAMPTZ NOT NULL,    -- e.g. submitted_at + 90 days
 
  -- Extraction pipeline status
  extraction_status   TEXT        NOT NULL DEFAULT 'pending',
                      -- 'pending', 'processing', 'complete', 'failed'
  extracted_at        TIMESTAMPTZ,
  extraction_error    TEXT,                    -- populated on failure
 
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
 
CREATE INDEX idx_photos_board             ON photos(board_id);
CREATE INDEX idx_photos_delete_after      ON photos(delete_after);
CREATE INDEX idx_photos_extraction_status ON photos(extraction_status);
CREATE INDEX idx_photos_previous          ON photos(previous_photo_id);
 
-- FK deferred until after photos table exists
ALTER TABLE boards
  ADD CONSTRAINT fk_boards_current_state_photo
  FOREIGN KEY (current_state_photo_id)
  REFERENCES photos(id)
  ON DELETE SET NULL;
 
 
-- Logical state of a board: which events are currently on it.
-- One row per board/event pair, ever — the row persists through removal,
-- recording the full history of when a flyer was present.
--
-- This is the source of truth for board character over time:
-- what kinds of events does this board carry, how fast do they turn over,
-- how many active flyers does it have right now?
--
-- Updated by the extraction pipeline:
--   - Event seen on this board → upsert, bump last_seen_at
--   - Event previously known, not seen in new full extraction → set removed_at
CREATE TABLE board_flyers (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id          UUID        NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  event_id          UUID        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
 
  -- Set when a subsequent full extraction of this board no longer shows this flyer.
  -- Null means the flyer is still believed to be present.
  removed_at        TIMESTAMPTZ,
 
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
 
  UNIQUE (board_id, event_id)  -- one record per board/event pair, ever
);
 
CREATE INDEX idx_board_flyers_board    ON board_flyers(board_id);
CREATE INDEX idx_board_flyers_event    ON board_flyers(event_id);
CREATE INDEX idx_board_flyers_active   ON board_flyers(is_active);
 
 
-- Individual event sightings.
-- Links a single AI extraction result to a canonical event.
-- This is where deduplication decisions land:
-- a new extraction either creates a new event or links to an existing one.
-- Survives photo deletion (photo_id goes null when photo is deleted).
CREATE TABLE event_sightings (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              UUID        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  photo_id              UUID        REFERENCES photos(id) ON DELETE SET NULL,
  board_id              UUID        REFERENCES boards(id) ON DELETE SET NULL,
 
  -- Raw extraction output from the AI for this specific event on this photo
  raw_extraction        JSONB       NOT NULL,
 
  -- How reliably did we read the flyer? (0.0–1.0)
  -- This is about the quality of the read, not the quantity of information.
  -- Low confidence = dark photo, occluded text, handwriting we couldn't parse.
  -- High confidence on a sparse flyer = we read it correctly; it's just sparse.
  -- Used as input to compute_event_confidence().
  extraction_confidence FLOAT       NOT NULL DEFAULT 0.5
                        CHECK (extraction_confidence BETWEEN 0.0 AND 1.0),
 
  -- What kind of flyer is this? (independent of how well we read it)
  -- Assessed by the AI from visual cues and informational density.
  -- This signal drives presentation, not gating:
  --   - 'minimal' events are shown with a style that matches their character
  --   - They are NOT penalized for having null fields
  -- Note: underground/minimal flyers should suppress automatic web enrichment.
  -- Null fields on a minimal flyer are intentional, not gaps to be filled.
  flyer_style           TEXT,
                        -- 'minimal'  - intentionally sparse; underground shows,
                        --              xeroxed flyers, cash-only, off-grid events.
                        --              Promoters know what they're doing.
                        --              Null fields are by design, not by failure.
                        -- 'standard' - typical community event flyer; some fields
                        --              present, some may be missing or partial
                        -- 'detailed' - professionally produced; full info expected
                        --              (venue calendar, ticketed show, etc.)
                        -- null       - not yet assessed (pre-v4 sightings)
 
  -- Optional enrichment from web search.
  -- Triggered automatically on low-confidence or null fields.
  -- NOT triggered for flyer_style = 'minimal' — null fields are intentional.
  -- CRITICAL: never use web search to fill in location_address for a minimal flyer.
  -- A flyer with no address is withholding it deliberately. House shows, private
  -- venues, and sensitive community spaces depend on this. Adding an address from
  -- a Facebook event or social post would be actively harmful.
  enrichment_source     TEXT,       -- null | 'web_search' | 'manual'
  enrichment_data       JSONB,      -- what fields were added/changed
 
  -- Poster crop — generated on demand, cached here.
  -- If the source photo is deleted, existing crops are preserved;
  -- missing crops cannot be regenerated.
  crop_url              TEXT,
  crop_generated_at     TIMESTAMPTZ,
 
  -- Review status.
  -- Default flow: pending → auto_approved (if confidence threshold met).
  -- Human queue: pending → approved | rejected (for exceptions only).
  review_status         TEXT        NOT NULL DEFAULT 'pending',
                        -- 'pending'        - awaiting confidence computation
                        -- 'auto_approved'  - confidence threshold met, no human needed
                        -- 'approved'       - human confirmed
                        -- 'rejected'       - human or AI rejected
  reviewed_by           UUID,       -- null for auto_approved
  reviewed_at           TIMESTAMPTZ,
 
  sighted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
 
CREATE INDEX idx_sightings_event       ON event_sightings(event_id);
CREATE INDEX idx_sightings_photo       ON event_sightings(photo_id);
CREATE INDEX idx_sightings_board       ON event_sightings(board_id);
CREATE INDEX idx_sightings_review      ON event_sightings(review_status);
CREATE INDEX idx_sightings_flyer_style ON event_sightings(flyer_style);
 
 
-- Web-sourced verifications for events.
-- Each row is one external URL that independently confirms the event.
-- trust_weight is copied from config at verification time so historical
-- records remain stable even if config values change later.
--
-- Verification is triggered automatically by the pipeline when
-- extraction_confidence is below the auto_approve threshold,
-- or on first sighting of any event.
-- Exception: flyer_style = 'minimal' suppresses automatic verification;
-- no web footprint is expected for off-grid events and its absence
-- should not count against them. Verification still runs if a user
-- report triggers re-verification of a minimal event.
CREATE TABLE event_verifications (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 
  source_url      TEXT        NOT NULL,
  source_type     TEXT        NOT NULL,
                  -- 'venue_website'  - the venue's own listings or calendar page
                  -- 'org_website'    - the organizer's own website
                  -- 'local_calendar' - alt-weekly, civic calendar, library site
                  -- 'ticketing'      - Eventbrite, Tixr, Brown Paper Tickets, etc.
                  -- 'social'         - Facebook event, Instagram post
                  -- 'news'           - local press coverage
 
  -- Snapshot of config trust weight at the time of verification.
  -- Do not update retroactively.
  trust_weight    FLOAT       NOT NULL
                  CHECK (trust_weight BETWEEN 0.0 AND 1.0),
 
  -- Which event fields this source confirmed or enriched.
  -- e.g. {"name": true, "date_start": true, "location_address": true}
  verified_fields JSONB,
 
  verified_by     TEXT        NOT NULL DEFAULT 'ai',
                  -- 'ai' | 'human'
 
  verified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
 
CREATE INDEX idx_verifications_event ON event_verifications(event_id);
CREATE INDEX idx_verifications_type  ON event_verifications(source_type);
 
 
-- User-submitted reports.
-- Feeds the AI moderation queue. AI handles resolution autonomously
-- using web search re-verification. Human escalation only for
-- unresolvable conflicts or abuse patterns.
--
-- Special resolution path for minimal flyers:
-- If report_type = 'wrong_info' or 'spam' and flyer_style = 'minimal'
-- and web search finds nothing, that is NOT evidence of spam.
-- Resolution logic: no web footprint + board location verified +
-- content_type consistent = insufficient evidence to dismiss.
-- Leave active with existing confidence rather than penalizing
-- an event for being underground.
CREATE TABLE event_reports (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 
  report_type     TEXT        NOT NULL,
                  -- 'already_happened' - event is in the past
                  -- 'wrong_info'       - date, location, name, etc. is incorrect
                  -- 'spam'             - not a real event
                  -- 'duplicate'        - same as another event
                  -- 'other'
 
  note            TEXT,       -- optional free-text from reporter
  reported_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
 
  -- Resolution
  status          TEXT        NOT NULL DEFAULT 'pending',
                  -- 'pending', 'resolved', 'dismissed'
  resolved_by     TEXT,       -- 'ai' | 'human'
  resolution_note TEXT,       -- explanation of decision, written by AI or human
  resolved_at     TIMESTAMPTZ,
 
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
 
CREATE INDEX idx_reports_event  ON event_reports(event_id);
CREATE INDEX idx_reports_status ON event_reports(status);
 
 
-- ============================================================
-- CONFIGURATION
-- Tunable without a deploy.
-- ============================================================
 
CREATE TABLE config (
  key         TEXT PRIMARY KEY,
  value       TEXT        NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
 
INSERT INTO config (key, value, description) VALUES
 
  -- Staleness windows
  ('event_staleness_days',           '30',   'Days without a sighting before a one-off event is flagged stale'),
  ('recurring_event_staleness_days', '180',  'Days without a sighting before a recurring event is flagged stale; longer because farmers markets, open mics, and support groups may not be re-photographed often'),
  ('board_staleness_days',           '180',  'Days without a sighting before a board is marked inactive'),
  ('org_staleness_days',             '365',  'Days without an active event before an org is considered dormant'),
  ('venue_staleness_days',           '365',  'Days without an active event before a venue is considered dormant'),
  ('talent_staleness_days',          '365',  'Days without an active event before a talent record is considered dormant'),
 
  -- Photo retention
  ('photo_retention_days',           '90',   'Days to retain photo images before deletion'),
  ('photo_record_retention',         '180',  'Days to retain photo records after image deletion'),
 
  -- Rate limiting
  -- Primary cost protection against abuse. Enforced at the API layer before
  -- photos are accepted. Adjust based on real contributor behavior.
  ('max_daily_submissions_per_user', '20',   'Maximum photo submissions per user per day'),
 
  -- Confidence display + auto-approval thresholds.
  -- min_confidence_display gates on extraction reliability only —
  -- it is not a completeness check. A minimal flyer with high extraction
  -- confidence displays normally regardless of how few fields are populated.
  ('min_confidence_display',         '0.3',  'Minimum extraction confidence to show an event publicly'),
  ('auto_approve_confidence',        '0.8',  'Confidence threshold for auto-approval without human review'),
 
  -- Confidence formula weights.
  -- Must sum to 1.0. Adjust based on real data once the app has usage.
  -- With defaults: max score without any web verification = 0.4 + 0.3 = 0.7,
  -- which is intentionally below auto_approve_confidence (0.8).
  -- Exception: minimal flyers are not penalized for lacking web verification —
  -- see auto_approve_confidence_minimal below.
  ('confidence_weight_extraction',   '0.4',  'Weight of AI extraction score in final confidence'),
  ('confidence_weight_sighting',     '0.3',  'Weight of sighting factor in final confidence'),
  ('confidence_weight_verification', '0.3',  'Weight of web verification score in final confidence'),
 
  -- Separate auto-approval threshold for minimal flyers.
  -- Because web verification is suppressed for off-grid events,
  -- their verification score stays 0.0 by design — not by failure.
  -- A lower threshold lets them auto-approve on extraction + sightings alone.
  -- With defaults: extraction(0.85) * 0.4 + sighting(f(2)=0.75) * 0.3 ≈ 0.565
  -- Set to 0.55 so a well-read flyer seen on two boards auto-approves.
  -- Adjust based on real spam rates once the app has usage.
  ('auto_approve_confidence_minimal','0.55', 'Auto-approval threshold for flyer_style = minimal events'),
 
  -- Sighting factor decay constant.
  -- Formula: sighting_factor = 1 - exp(-lambda * n)
  -- n = number of DISTINCT BOARDS, not total photos.
  -- With lambda=0.7: n=1 → 0.50, n=2 → 0.75, n=3 → 0.88, n=5 → 0.97
  -- Increase lambda to reward early sightings more; decrease to flatten the curve.
  ('sighting_lambda',                '0.7',  'Decay constant for sighting diminishing-returns curve'),
 
  -- Source trust weights.
  -- Copied into event_verifications.trust_weight at verification time.
  -- Verification score uses probabilistic OR combination:
  --   P(confirmed) = 1 - PRODUCT(1 - trust_weight_i)
  -- So two sources (0.9 + 0.8) together yield ~0.98 verification score.
  -- venue_website is the highest-trust source and the natural candidate
  -- for future direct event ingestion (venue calendar scraping).
  ('trust_weight_venue_website',     '0.90', 'Trust: venue''s own website or calendar page'),
  ('trust_weight_org_website',       '0.85', 'Trust: organizer''s own website'),
  ('trust_weight_local_calendar',    '0.80', 'Trust: local alt-weekly or civic/library calendar'),
  ('trust_weight_ticketing',         '0.75', 'Trust: Eventbrite, Tixr, Brown Paper Tickets, etc.'),
  ('trust_weight_news',              '0.70', 'Trust: local press coverage'),
  ('trust_weight_social',            '0.50', 'Trust: Facebook event, Instagram post');
 
 
-- ============================================================
-- SEARCH TEXT GENERATOR
-- Builds the human-readable event summary used for embedding
-- and full-text search. Called by compute_event_confidence()
-- after every meaningful update so search_text is always current.
--
-- Template output example:
--   "Music show. The Gobs headline, Cherry Cheeks opens. Saturday
--    Jun 15 at Obsidian. All ages, free. Benefit for the food bank.
--    punk, local. Wheelchair accessible, no one turned away."
--
-- Field ordering is deliberate: most discriminating information first.
-- Embedding models weight earlier tokens more heavily; category and
-- talent identify what the event is before location and price qualify it.
-- ============================================================
 
CREATE OR REPLACE FUNCTION generate_search_text(p_event_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  e               events%ROWTYPE;
  talent_summary  TEXT;
  date_summary    TEXT;
  time_summary    TEXT;
  result          TEXT;
BEGIN
  SELECT * INTO e FROM events WHERE id = p_event_id;
 
  -- Talent: "The Gobs headline, Cherry Cheeks opens"
  -- Falls back to flat list if roles aren't set.
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
 
  -- Date: "Saturday Jun 15" / "every Wednesday" / raw string
  date_summary := CASE e.date_type
    WHEN 'specific'    THEN to_char(e.date_start, 'Day Mon DD')
    WHEN 'recurring'   THEN COALESCE(e.date_raw, 'recurring')
    WHEN 'approximate' THEN e.date_raw
    ELSE NULL
  END;
 
  -- Time: "7:00 PM" or "7:00 PM – 10:00 PM"
  time_summary := CASE
    WHEN e.time_start IS NOT NULL AND e.time_end IS NOT NULL
      THEN to_char(e.time_start, 'HH12:MI AM') || ' – ' || to_char(e.time_end, 'HH12:MI AM')
    WHEN e.time_start IS NOT NULL
      THEN to_char(e.time_start, 'HH12:MI AM')
    ELSE NULL
  END;
 
  -- Assemble: concat_ws skips NULLs automatically.
  result := concat_ws(' ',
    -- Category
    e.event_category,
 
    -- Talent
    talent_summary,
 
    -- When and where
    concat_ws(' at ',
      concat_ws(', ', date_summary, time_summary),
      e.location_name
    ),
 
    -- Audience / price
    concat_ws(', ',
      e.age_restriction,
      e.price_raw,
      CASE WHEN e.language IS NOT NULL AND e.language <> 'en'
           THEN 'language: ' || e.language ELSE NULL END,
      CASE WHEN e.is_outdoor = true  THEN 'outdoor' ELSE NULL END,
      CASE WHEN e.is_outdoor = false THEN 'indoor'  ELSE NULL END
    ),
 
    -- Description
    e.description,
 
    -- Tags
    CASE WHEN e.tags IS NOT NULL THEN array_to_string(e.tags, ', ') ELSE NULL END,
 
    -- Accessibility
    concat_ws(', ',
      CASE WHEN e.accessibility IS NOT NULL
           THEN array_to_string(e.accessibility, ', ') ELSE NULL END,
      CASE WHEN e.masks_required IS NOT NULL
           THEN 'masks: ' || e.masks_required ELSE NULL END
    )
  );
 
  -- Write back.
  -- Embedding regeneration is a separate async pipeline step triggered
  -- by a change in search_text (compare old vs new before updating).
  UPDATE events
  SET search_text = result, updated_at = now()
  WHERE id = p_event_id;
 
  RETURN result;
END;
$$;
 
 
-- ============================================================
-- CONFIDENCE FUNCTION
-- Called automatically by triggers after any INSERT/UPDATE/DELETE
-- on event_sightings or event_verifications.
-- Can also be called manually to recompute after config changes.
--
-- Formula:
--   extraction_score   = AVG(extraction_confidence) across non-rejected sightings
--   board_count        = COUNT(DISTINCT board_id) across non-rejected sightings
--   sighting_factor    = 1 - exp(-lambda * board_count)
--   verification_score = 1 - PRODUCT(1 - trust_weight_i) across all verifications
--   final = w_e * extraction + w_s * sighting_factor + w_v * verification_score
--
-- Note: sighting_factor uses distinct board count, not total sighting count.
-- Photographing the same board ten times counts the same as photographing it once.
-- Geographic independence is what builds confidence, not photo volume.
--
-- Minimal flyers:
--   - verification_score stays 0.0 (web search is suppressed by design)
--   - a separate lower auto-approval threshold applies (auto_approve_confidence_minimal)
--   - flyer_style is written to events for use by the presentation layer
--
-- Side effects:
--   - Writes confidence_score, confidence_breakdown, and flyer_style to events
--   - Promotes pending sightings to auto_approved if threshold is met
-- ============================================================
 
CREATE OR REPLACE FUNCTION compute_event_confidence(p_event_id UUID)
RETURNS FLOAT
LANGUAGE plpgsql
AS $$
DECLARE
  -- Config
  w_extraction           FLOAT;
  w_sighting             FLOAT;
  w_verification         FLOAT;
  lambda                 FLOAT;
  approve_threshold      FLOAT;
  approve_threshold_min  FLOAT;
 
  -- Components
  extraction_score   FLOAT;
  board_count        INT;
  sighting_factor    FLOAT;
  verification_score FLOAT;
  source_urls        TEXT[];
  event_flyer_style  TEXT;
 
  -- Effective threshold for this event
  effective_threshold FLOAT;
 
  -- Output
  final_score FLOAT;
  breakdown   JSONB;
BEGIN
  -- Load config
  SELECT value::FLOAT INTO w_extraction          FROM config WHERE key = 'confidence_weight_extraction';
  SELECT value::FLOAT INTO w_sighting            FROM config WHERE key = 'confidence_weight_sighting';
  SELECT value::FLOAT INTO w_verification        FROM config WHERE key = 'confidence_weight_verification';
  SELECT value::FLOAT INTO lambda                FROM config WHERE key = 'sighting_lambda';
  SELECT value::FLOAT INTO approve_threshold     FROM config WHERE key = 'auto_approve_confidence';
  SELECT value::FLOAT INTO approve_threshold_min FROM config WHERE key = 'auto_approve_confidence_minimal';
 
  -- 1. Extraction score: average confidence across all non-rejected sightings.
  --    Includes 'pending' so a brand-new event gets a real score immediately.
  --    Board count uses DISTINCT board_id — multiple photos of the same board
  --    count as one. Geographic independence is what matters.
  SELECT
    COALESCE(AVG(extraction_confidence), 0.5),
    COALESCE(COUNT(DISTINCT board_id),   0)
  INTO extraction_score, board_count
  FROM event_sightings
  WHERE event_id    = p_event_id
    AND review_status != 'rejected';
 
  -- 2. Sighting factor: diminishing returns curve over distinct board count.
  --    f(0) = 0.0, f(1) ≈ 0.50, f(2) ≈ 0.75, f(3) ≈ 0.88, f(5) ≈ 0.97
  sighting_factor := 1.0 - EXP(-lambda * board_count);
 
  -- 3. Verification score: probabilistic OR combination of source trust weights.
  --    If there are no verifications, score is 0.0.
  --    For standard/detailed events this means they cannot reach auto_approve
  --    without at least one web source.
  --    For minimal events, 0.0 is expected — the threshold is adjusted instead.
  SELECT
    CASE
      WHEN COUNT(*) = 0 THEN 0.0
      -- Use the log trick to avoid floating point underflow on PRODUCT:
      --   ln(PRODUCT(1 - w_i)) = SUM(ln(1 - w_i))
      ELSE 1.0 - EXP(SUM(LN(GREATEST(1.0 - trust_weight, 0.0001))))
    END,
    ARRAY_AGG(source_url)
  INTO verification_score, source_urls
  FROM event_verifications
  WHERE event_id = p_event_id;
 
  source_urls := COALESCE(source_urls, ARRAY[]::TEXT[]);
 
  -- 4. Consensus flyer style: majority vote across non-rejected sightings.
  --    mode() returns the most frequent non-null value.
  --    NULL if all sightings have null flyer_style (pre-v4 data).
  SELECT mode() WITHIN GROUP (ORDER BY flyer_style)
  INTO event_flyer_style
  FROM event_sightings
  WHERE event_id    = p_event_id
    AND review_status != 'rejected'
    AND flyer_style IS NOT NULL;
 
  -- 5. Weighted combination, capped at 1.0.
  final_score := LEAST(1.0,
    (extraction_score    * w_extraction)  +
    (sighting_factor     * w_sighting)    +
    (verification_score  * w_verification)
  );
 
  -- 6. Build the breakdown for auditing and display.
  breakdown := jsonb_build_object(
    'extraction',    ROUND(extraction_score::NUMERIC,    4),
    'sighting',      ROUND(sighting_factor::NUMERIC,     4),
    'board_count',   board_count,
    'verification',  ROUND(verification_score::NUMERIC,  4),
    'flyer_style',   event_flyer_style,
    'sources',       to_jsonb(source_urls),
    'computed_at',   now()
  );
 
  -- 7. Write confidence and flyer_style back to the event.
  UPDATE events
  SET
    confidence_score     = final_score,
    confidence_breakdown = breakdown,
    flyer_style          = event_flyer_style,
    sighting_count       = board_count,
    updated_at           = now()
  WHERE id = p_event_id;
 
  -- 8. Auto-approve pending sightings if the event has cleared its threshold.
  --    Minimal events use a lower threshold because web verification is
  --    intentionally absent — their 0.0 verification score is not a failure.
  --    Done after the confidence update so the decision is based on the
  --    full current picture.
  effective_threshold := CASE
    WHEN event_flyer_style = 'minimal' THEN approve_threshold_min
    ELSE approve_threshold
  END;
 
  IF final_score >= effective_threshold THEN
    UPDATE event_sightings
    SET
      review_status = 'auto_approved',
      reviewed_at   = now()
    WHERE event_id      = p_event_id
      AND review_status = 'pending';
  END IF;
 
  -- 9. Regenerate search_text now that confidence and flyer_style are current.
  --    Embedding regeneration is handled separately (async, post-approval).
  PERFORM generate_search_text(p_event_id);
 
  RETURN final_score;
END;
$$;
 
 
-- ============================================================
-- TRIGGERS
-- Recompute confidence whenever sightings or verifications change.
-- ============================================================
 
CREATE OR REPLACE FUNCTION trg_recompute_on_sighting()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM compute_event_confidence(
    CASE TG_OP WHEN 'DELETE' THEN OLD.event_id ELSE NEW.event_id END
  );
  RETURN NULL;
END;
$$;
 
CREATE TRIGGER trg_sighting_confidence
AFTER INSERT OR UPDATE OR DELETE ON event_sightings
FOR EACH ROW EXECUTE FUNCTION trg_recompute_on_sighting();
 
 
CREATE OR REPLACE FUNCTION trg_recompute_on_verification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM compute_event_confidence(
    CASE TG_OP WHEN 'DELETE' THEN OLD.event_id ELSE NEW.event_id END
  );
  RETURN NULL;
END;
$$;
 
CREATE TRIGGER trg_verification_confidence
AFTER INSERT OR UPDATE OR DELETE ON event_verifications
FOR EACH ROW EXECUTE FUNCTION trg_recompute_on_verification();
 
 
-- ============================================================
-- PUBLIC VIEWS
-- ============================================================
 
-- Consumer-facing event feed.
-- Active events above the display confidence threshold.
-- Includes venue, org, talent, and all discovery metadata so the
-- presentation layer has everything it needs without additional joins.
-- embedding is intentionally excluded — it is internal to the pipeline.
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
  -- JSON array of talent: [{id, name, talent_type, role, billing_position}, ...]
  -- Ordered by billing_position ascending, nulls last.
  -- role and talent_type let the UI render "performing", "speaking",
  -- "exhibiting" etc. without hardcoding music vocabulary.
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
  )                   AS talent
FROM events e
LEFT JOIN organizations o  ON o.id = e.organization_id
LEFT JOIN venues v         ON v.id = e.venue_id
LEFT JOIN event_talent et  ON et.event_id = e.id
LEFT JOIN talent t         ON t.id = et.talent_id
WHERE e.is_active = true
  AND e.confidence_score >= (
    SELECT value::FLOAT FROM config WHERE key = 'min_confidence_display'
  )
GROUP BY e.id, o.name, o.website, v.id, v.name, v.website, v.address, v.geolocation, v.accessibility;
 
 
-- Board activity summary.
-- Powers "hottest boards near you" queries and board profile pages.
-- active_flyer_count  — how many events are on it right now
-- total_flyer_count   — all-time flyers (measures board history/richness)
-- content_mix         — distinct content types present (board character)
CREATE VIEW boards_public AS
SELECT
  b.id,
  b.geolocation,
  b.description,
  b.board_type,
  b.posting_policy,
  b.allowed_content_types,
  b.first_sighted_at,
  b.last_sighted_at,
  COUNT(bf.id) FILTER (WHERE bf.is_active = true)  AS active_flyer_count,
  COUNT(bf.id)                                      AS total_flyer_count,
  ARRAY_AGG(DISTINCT e.content_type)
    FILTER (WHERE bf.is_active = true)              AS content_mix
FROM boards b
LEFT JOIN board_flyers bf ON bf.board_id = b.id
LEFT JOIN events e        ON e.id = bf.event_id
WHERE b.is_active = true
GROUP BY b.id;
 
 
-- Venue activity summary.
-- Powers "venues near you" and venue profile pages.
-- upcoming_event_count — how many future events are currently scheduled
-- next_event_date      — when is the next event (nil if none scheduled)
-- recent_talent        — talent that has played here recently (last 90 days),
--                        for surfacing venue character without a full event list
CREATE VIEW venues_public AS
SELECT
  v.id,
  v.name,
  v.address,
  v.geolocation,
  v.website,
  v.description,
  v.venue_type,
  v.first_seen_at,
  v.last_active_at,
  COUNT(e.id)      FILTER (WHERE e.is_active = true
                             AND e.date_start >= CURRENT_DATE)   AS upcoming_event_count,
  MIN(e.date_start) FILTER (WHERE e.is_active = true
                              AND e.date_start >= CURRENT_DATE)  AS next_event_date,
  -- Distinct talent seen at this venue in the last 90 days.
  -- Gives the venue a character fingerprint without listing every past event.
  ARRAY_AGG(DISTINCT t.name)
    FILTER (WHERE e.is_active = true
              AND e.date_start >= CURRENT_DATE - INTERVAL '90 days'
              AND t.name IS NOT NULL)                             AS recent_talent
FROM venues v
LEFT JOIN events e      ON e.venue_id = v.id
LEFT JOIN event_talent et ON et.event_id = e.id
LEFT JOIN talent t      ON t.id = et.talent_id
WHERE v.is_active = true
GROUP BY v.id;
 
 
-- Talent activity summary.
-- Powers talent profile pages and follow/notification features.
-- upcoming_event_count — scheduled future appearances
-- next_event_date      — next known appearance date
-- recent_venues        — venues played recently (last 90 days),
--                        for understanding where a band tends to play
-- follower_count       — users following this talent record
--                        (follows table also supports venue/org follows;
--                        this count is scoped to talent_id rows only)
CREATE VIEW talent_public AS
SELECT
  t.id,
  t.name,
  t.website,
  t.description,
  t.first_seen_at,
  t.last_active_at,
  COUNT(DISTINCT et.event_id)
    FILTER (WHERE e.is_active = true
              AND e.date_start >= CURRENT_DATE)                  AS upcoming_event_count,
  MIN(e.date_start)
    FILTER (WHERE e.is_active = true
              AND e.date_start >= CURRENT_DATE)                  AS next_event_date,
  ARRAY_AGG(DISTINCT v.name)
    FILTER (WHERE e.is_active = true
              AND e.date_start >= CURRENT_DATE - INTERVAL '90 days'
              AND v.name IS NOT NULL)                            AS recent_venues,
  COUNT(DISTINCT f.user_id)                                      AS follower_count
FROM talent t
LEFT JOIN event_talent et ON et.talent_id = t.id
LEFT JOIN events e        ON e.id = et.event_id
LEFT JOIN venues v        ON v.id = e.venue_id
LEFT JOIN follows f       ON f.talent_id = t.id
WHERE t.is_active = true
GROUP BY t.id;
 
 
-- Active board locations for each event.
-- Powers the "find this flyer in the wild" feature.
--
-- When an event card is sparse, or the user wants more information than
-- the database has, point them to the physical boards where the flyer is
-- currently posted. The board is the canonical source of truth; the database
-- is a discovery index, not a replacement for the physical object.
--
-- For minimal flyers this is the PRIMARY answer to "I want more info" —
-- not a fallback. The flyer is intentionally sparse; what the database
-- doesn't have, the physical object does.
--
-- last_seen_at is exposed deliberately. Show it honestly in the UI:
-- "last confirmed 4 days ago" lets users calibrate their own expectations
-- rather than the app making a promise it can't keep. A board visit is a
-- short errand, not a guaranteed outcome.
--
-- Query by event_id to get all active boards for a single event.
-- Join with ST_Distance(geolocation, user_location) to sort by proximity.
CREATE VIEW event_board_locations AS
SELECT
  bf.event_id,
  b.id              AS board_id,
  b.geolocation,
  b.description     AS board_description,
  b.board_type,
  bf.first_seen_at,
  bf.last_seen_at
FROM board_flyers bf
JOIN boards b ON b.id = bf.board_id
WHERE bf.is_active = true
  AND b.is_active  = true;
 
 
-- ============================================================
-- EXPIRY JOBS
-- Run on a schedule (e.g. nightly cron via pg_cron or external scheduler).
-- ============================================================
 
-- Mark events stale that haven't been sighted recently
-- and have no known future date.
-- Recurring events use a longer staleness window:
--
-- UPDATE events SET is_active = false
-- WHERE is_active = true
--   AND (expires_at IS NULL OR expires_at < now())
--   AND last_sighted_at < now() - (
--     CASE
--       WHEN date_type = 'recurring'
--       THEN (SELECT value::int FROM config WHERE key = 'recurring_event_staleness_days')
--       ELSE COALESCE(staleness_days, (SELECT value::int FROM config WHERE key = 'event_staleness_days'))
--     END
--     || ' days')::interval;
 
-- Deactivate board_flyers for expired events:
--
-- UPDATE board_flyers SET is_active = false, removed_at = now()
-- WHERE is_active = true
--   AND event_id IN (SELECT id FROM events WHERE is_active = false);
 
-- Mark boards inactive that haven't been sighted recently:
--
-- UPDATE boards SET is_active = false
-- WHERE is_active = true
--   AND last_sighted_at < now() - (
--     (SELECT value::int FROM config WHERE key = 'board_staleness_days') || ' days')::interval;
 
-- Mark venues dormant when they have had no active events for a long time:
--
-- UPDATE venues SET is_active = false
-- WHERE is_active = true
--   AND (last_active_at IS NULL OR last_active_at < now() - (
--     (SELECT value::int FROM config WHERE key = 'venue_staleness_days') || ' days')::interval);
 
-- Mark talent dormant when they have had no active events for a long time:
--
-- UPDATE talent SET is_active = false
-- WHERE is_active = true
--   AND (last_active_at IS NULL OR last_active_at < now() - (
--     (SELECT value::int FROM config WHERE key = 'talent_staleness_days') || ' days')::interval);
 
-- Delete photo images past their retention date:
--
-- UPDATE photos SET image_url = null, image_deleted_at = now()
-- WHERE image_url IS NOT NULL
--   AND delete_after < now();
 
-- Delete photo records past their record retention date:
--
-- DELETE FROM photos
-- WHERE image_deleted_at IS NOT NULL
--   AND image_deleted_at < now() - (
--     (SELECT value::int FROM config WHERE key = 'photo_record_retention') || ' days')::interval;
 
-- Resolve stale pending reports whose event is no longer active:
--
-- UPDATE event_reports SET status = 'resolved', resolved_by = 'ai',
--   resolution_note = 'Event expired', resolved_at = now()
-- WHERE status = 'pending'
--   AND event_id IN (SELECT id FROM events WHERE is_active = false);
 

