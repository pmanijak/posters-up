-- ============================================================
-- MIGRATION: event_name_similarity() + enrichment identity guards
-- ============================================================
--
-- Problem: enrich's web search step can find a real, well-corroborated
-- event that shares something with a stored event record — a name, a
-- recurring format — without actually being that event, and report
-- fields as verified anyway. Two concrete cases:
--
--   NAME: an event stored as "Frolicking Card Show" got 4 verification
--   sources — all of them describing "Front Row Card Show" — with
--   "name" marked verified on two of them. Same real event, misread
--   name on the flyer; the model never checked its find against the
--   name it was given.
--
--   DATE: an event stored as "Porchfest" (Olympia board, flyer dated
--   2026-07-18) got verified against Olympia's own separate, real
--   Porch Fest — which runs on Labor Day, not in July. Tacoma
--   Porchfest runs July 18-19 and is what that flyer actually
--   describes, cross-posted to an Olympia board. The board's city
--   constraint steered the search toward the wrong, same-named local
--   event instead of the right out-of-town one — same underlying
--   failure as the name case, different field, and a real recurring
--   risk given how many event formats (Porchfest, Pride, Restaurant
--   Week, farmers market openers...) run independently city to city
--   under the same name.
--
-- Both cases share the same root cause: the prompt's VERIFIED FIELDS
-- section tells the model what kind of source confirms which fields,
-- but never tells it to check what it found against what it was
-- given -- the same identity-check discipline the TALENT
-- DISAMBIGUATION block already applies to performers was never
-- extended to the event's own name or date.
--
-- This is fixed on two sides:
--   1. Prompt (enrich/index.ts): new EVENT IDENTITY + DATE IDENTITY
--      blocks, and a found.name field so the model reports what name
--      it actually found (found.date_start already existed).
--   2. Code (enrich/index.ts): before writing event_verifications,
--      strip "name" from verified_fields when found.name doesn't
--      clear a similarity floor against the stored event name, and
--      strip date_start/date_end/time_start/time_end when
--      found.date_start is more than a few days from the stored
--      date_start.
--
-- event_name_similarity() exists so the name check reuses the exact
-- same normalize_event_name() + pg_trgm similarity() already load-
-- bearing for dedup, rather than reimplementing text normalization in
-- TypeScript where it would inevitably drift from the SQL version.
-- The date check needs no equivalent SQL helper -- it's a plain day-
-- count comparison, cheap and unambiguous directly in TypeScript.
--
-- Reuses the false_merge_similarity_floor value (0.30) as the name
-- floor's default rather than inventing a new number: same underlying
-- question in both places -- "are these two strings describing the
-- same named thing, or textually unrelated" -- just applied to
-- enrichment source identity instead of sighting-merge identity.
-- Kept as its own config key (not a read of false_merge_similarity_floor
-- itself) so the two can be tuned independently if experience shows
-- they should diverge. The date tolerance (3 days) has no equivalent
-- existing config value to mirror -- see DATE_MISMATCH_TOLERANCE_DAYS
-- in enrich/index.ts for why it's deliberately wider than
-- run_dedup_pass()'s ABS(...) <= 1 day OCR-slop window: this isn't
-- reconciling two readings of one date, it's distinguishing "the same
-- event" from "a different instance of a recurring format."
-- ============================================================

INSERT INTO config (key, value, description) VALUES
  ('enrichment_name_similarity_floor', '0.30',
   'enrich: below this pg_trgm similarity between events.name and the
    name a web source actually reported (found.name), "name" is
    stripped from that source''s verified_fields before the
    event_verifications insert -- the source may still corroborate
    date/location, but does not get credit for confirming an identity
    it does not match. Mirrors false_merge_similarity_floor''s 0.30
    default; same question, different pipeline stage.')
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------
-- EVENT NAME SIMILARITY
-- Thin wrapper around normalize_event_name() + pg_trgm similarity(),
-- so callers outside SQL (the enrich Edge Function) don't need to
-- reimplement the normalization pass. NULL-safe: a NULL on either
-- side returns 0.0 (no basis for a match), not NULL -- callers
-- comparing against a numeric floor shouldn't have to NULL-check
-- separately from the floor check itself.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION event_name_similarity(p_a TEXT, p_b TEXT)
RETURNS FLOAT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_a IS NULL OR p_b IS NULL THEN 0.0
    ELSE similarity(normalize_event_name(p_a), normalize_event_name(p_b))
  END;
$$;

REVOKE EXECUTE ON FUNCTION event_name_similarity(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_name_similarity(TEXT, TEXT) TO service_role, anon, authenticated;