# Posters Up — Architecture

*Stable design decisions. This document changes slowly. Current build status lives in `handoff.md`. Current schema lives in `schema_current.sql`.*

---

## What This Is

A crowdsourced bulletin board event app for small cities. Contributors photograph physical bulletin boards, GPS-tag them, and submit photos. AI extracts structured event data from the photos. Users discover nearby events via a clean discovery feed.

The app is **purely observational** — contributors photograph the world, the pipeline indexes it, users discover it. Nobody posts events, claims listings, or manages a profile. This is a deliberate identity choice, not a missing feature.

The target is small cities (currently Olympia, WA) where word-of-mouth isn't quite enough to market a community event, and where many real events never make it onto Eventbrite or Facebook. The moat is the contributor network and the data pipeline, not a custom model.

Live at: **postersup.org**

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Database | Supabase (Postgres + PostGIS + pgvector + pg_trgm) | Managed; no servers to babysit |
| Auth | Supabase Auth | Magic link email only |
| Storage | Supabase Storage | `photos-raw` bucket |
| Backend | Supabase Edge Functions (Deno) | `extract`, `enrich`; cron-scheduled |
| AI | Anthropic claude-sonnet-4-6 | Vision extraction + web search enrichment |
| Frontend | Next.js 15 App Router, Tailwind v4, Vercel | |

Edge Functions use the service role key and bypass RLS. The `anon` and `authenticated` roles are for public discovery reads and contributor uploads respectively — not pipeline writes.

---

## Pipeline Overview

A photo travels through five stages before an event becomes discoverable:

```
Photo upload
     │
     ▼
[extract]   — vision LLM reads the photo, returns structured JSON per flyer
     │
     ▼
[find_event_match()]  — URL match → talent anchor match → fuzzy name+date+location match → new event
     │
     ▼
[enrich]    — separate cron function (every minute, one event per run)
     │         web search fills gaps; suppressed for minimal flyers
     │         results go to enrichment_data and event_verifications only
     │         (kept separate from extract to avoid adding latency to an
     │          already 75-second extraction call)
     ▼
[compute_event_confidence()]  — triggered automatically by DB; no manual step
     │
     ▼
[expiry jobs]  — nightly; retire stale events, deactivate board flyers, clean photos
```

---

## Core Design Principles

These are settled decisions. Revisiting them requires a good reason.

### 1. The flyer is the truth. The web is a witness.

`events` holds **only what the flyer says**. Web search results are never written to `events` field columns. This distinction matters in practice: a touring musician's Ohio show can surface when searching for his Olympia appearance. If enrichment wrote to `events`, that wrong-city show would corrupt the record.

Web-found data has exactly two destinations:
- `event_sightings.enrichment_data` — structured JSON of what the web found, stored as a separate layer. The presentation layer reads this to display a distinct "found online" section with source attribution.
- `event_verifications` — one row per web source; feeds the confidence trigger. This is the only path by which enrichment affects `events` — indirectly, via confidence score.

The only field `enrich` writes to `events` directly is `enrichment_attempted_at`.

### 2. Confidence measures reliability, not completeness.

A sparse flyer read perfectly has **high confidence**. A detailed flyer photographed from a bad angle has **low confidence**. These are categorically different situations.

Confidence formula:
```
extraction_score   = AVG(extraction_confidence) across non-rejected sightings
sighting_factor    = 1 - exp(-0.7 × distinct_board_count)
verification_score = 1 - PRODUCT(1 - trust_weight_i) across all verifications

final = 0.4 × extraction + 0.3 × sighting + 0.3 × verification
```

Key properties of this formula:
- `sighting_factor` uses **distinct board count**, not total photo count. Photographing the same board ten times counts the same as once. Geographic independence is what builds confidence.
- Max score without any web verification: `0.7` — intentionally below the `0.8` auto-approve threshold. Standard events cannot auto-approve without at least one web source.
- Minimal events have a separate lower threshold (`0.55`) because web verification is absent by design, not by failure.
- All weights live in the `config` table; never hardcoded.

### 3. Flyer style is a character signal, not a quality gate.

`flyer_style` describes what kind of flyer this is. It drives **presentation**, not **gating**.

| Style | Meaning | Treatment |
|---|---|---|
| `minimal` | Intentionally sparse — xeroxed aesthetic, underground show, cash at door | Web enrichment suppressed; lower auto-approve threshold; board is the primary "more info" answer |
| `standard` | Typical community event flyer; some fields may be missing | Normal enrichment; normal threshold |
| `detailed` | Professionally produced; full info expected | Normal enrichment; normal threshold |

The absence of a web footprint is **not a spam signal** for minimal events. The moderation logic knows: no web presence + board location verified + content type consistent = insufficient evidence to dismiss. Leave active with existing confidence.

Tags (genre, audience) are often inferable from visual style on minimal flyers — a rough xerox aesthetic strongly implies punk/DIY even without text confirming it.

### 4. The board is the answer for sparse events.

When an event card has limited information, the right response is often to point the user to the physical board — not to find more data. The app is a discovery index, not a replacement for the object it indexes.

For minimal flyers this is the **primary** answer to "I want more information," not a fallback. The flyer is intentionally sparse; what the database doesn't have, the physical object does. Sending someone to Rainy Day Records to read the flyer themselves is the correct product behavior.

`last_seen_at` must always be shown honestly. "Last confirmed 4 days ago" lets users calibrate their expectations. A board visit is a short errand, not a guaranteed outcome.

The `event_board_locations` view makes this trivial: query by `event_id`, sort by `ST_Distance` from the user, show `board_description` and `last_seen_at`. No inference, no enrichment, no privacy risk.

### 5. Personal contacts are never public.

Personal phone numbers and personal email addresses found on flyers (in `raw_extraction`) or found during web search (in `enrichment_data`) are **never promoted to public-facing fields**.

The `events.contact` field is public-facing and contains only public-facing URLs: venue websites, booking pages, org sites, public phone lines. The pipeline must never write a personal mobile number or personal email to this field — `confidence_note` is used to log "personal contact withheld."

`enrichment_data` is on `event_sightings`, which is not exposed in any public view. The presentation layer is responsible for what to surface from it — only public-facing URLs, never personal contacts. The pipeline stores raw web results without filtering; the presentation layer does the filtering.

`confidence_note` in the extraction output does double duty: it flags both reading quality issues ("low contrast on date field") and contact policy decisions ("personal contact withheld — mobile number on flyer"). Pipeline code that parses `confidence_note` should account for both patterns.

### 6. Deduplication is conservative.

A false merge (two events wrongly merged into one) corrupts confidence on the wrong record and loses information. A duplicate listing is survivable and self-corrects as the confidence pipeline runs. Therefore: **when in doubt, create a new event.**

`find_event_match()` uses three tiers, in priority order:

1. **URL hard match** — same `event_url` = same event, no ambiguity
2. **Talent anchor match** — same top-billed act + date within 1 day + location similarity ≥ 0.60
3. **Fuzzy name match** — normalized name similarity ≥ 0.65 + date within 1 day + location similarity ≥ 0.65 (or ≥ 0.90 with no location)

The normalization function (`normalize_event_name()`) strips venue suffixes ("— McCoys Tavern"), date fragments ("June 18"), and filler words before comparison. This matters because the AI often includes venue or date in the event name inconsistently.

The nightly `run_dedup_pass()` function scans for duplicates and can merge them, but the default merge strategy is canonical = older record, which is safe because `merge_events()` fills canonical's nulls from the duplicate anyway.

One schema constraint to keep in mind when writing merge logic: `event_verifications.source_url_normalized` is a **generated column** — it cannot be INSERTed or UPDATEd directly. When re-pointing verifications from a duplicate to a canonical event, delete any rows whose normalized URL already exists on the canonical first, then UPDATE the remainder.

### 7. Boards are never deleted.

`event_sightings.board_id` uses `ON DELETE SET NULL`. If a board is deleted, those sightings lose their board reference, and `compute_event_confidence()` counts `DISTINCT board_id` — a null board_id is never counted. Deleting boards silently deflates confidence on events that were sighted there.

Convention: mark boards inactive with `is_active = false`. Never `DELETE`.

### 8. Events are in local time, not server time.

Timezone bugs bite: an 8pm show in Olympia disappears from "today's" list at around noon if dates are computed in UTC. All date comparisons use the event's **local timezone** — currently `America/Los_Angeles` for Olympia, but designed to come from city config as more cities are added.

`new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())` is the pattern; never `new Date().toISOString().split('T')[0]`.

### 9. The extraction prompt is the canonical source.

`extraction-prompt.md` in the project files is the authoritative extraction system prompt. The Edge Function embeds it directly. If they diverge, the prompt in `extraction-prompt.md` wins — the function was synced to it intentionally, and any future prompt changes should update the project file first.

The prompt includes developer notes for known edge cases: dark-background gig posters, minimal flyers that over-flag null confidence, QR codes, handwritten text, crossed-out corrections, store hours mistaken for recurring events, and multi-performance runs. These are real patterns observed in early Olympia testing.

### 10. Prompt caching is a production optimization.

The extraction system prompt is ~3-4k tokens and identical on every call. It's a strong candidate for Anthropic's prompt caching (mark with `cache_control: { type: "ephemeral" }`). Same applies to the enrichment prompt. Not implemented yet, but worth doing before scaling contributor volume.

---

## Entity Model

Three distinct entity types for named things in the world:

- **Venues** — physical spaces that host events (Obsidian, the Olympia Library). Have permanent accessibility info from web enrichment.
- **Organizations** — promoters and community groups that run events. Not the space, not the performers.
- **Talent** — performers, speakers, artists, filmmakers, facilitators. Many-to-many with events via `event_talent`. `billing_position` captures prominence on the flyer (1 = top of bill).

A record store bulletin board is **not** a venue in this model. It's a board. The board is posting infrastructure; a venue is a named entity that hosts events.

---

## Sighting Model

One canonical `events` record per real-world event, regardless of how many boards show it or how many times it's photographed.

```
events          ← one record per real-world event
event_sightings ← one record per extraction that produced this event
board_flyers    ← one record per board that has shown this event (ever)
```

A new photo of a board showing a known event creates a new `event_sightings` row and bumps `board_flyers.last_seen_at`. It does **not** merge or update the canonical `events` record directly. The confidence trigger fires automatically and recomputes the score.

The board_flyers table has a `removed_at` column, but the extraction pipeline does not write to it. Flyers are marked inactive only through staleness expiry or user reports — absence from a photo is not inferred as removal.

When inserting a board via the Supabase client (PostgREST), the `geolocation` field must use the SRID prefix: `SRID=4326;POINT(lng lat)`. Bare WKT (`POINT(lng lat)`) is silently rejected by PostgREST for geography columns.

---

## City Scaling

**The database is a single global instance.** There is no `city` or `region` column anywhere in the schema. Everything is a coordinate. A user in Tumwater and a user in Olympia query "events within X miles of me" — town boundaries don't exist in the data model. PostGIS handles multi-city natively without any schema change. This was an explicit early decision: separate databases per city would complicate deduplication, queries, and operations, and offer no real benefit at this scale.

Adding a new city requires no engineering — only contributors showing up. The geographic data model handles it automatically:

- Boards have `geo_city`/`geo_region`/`geo_country` populated by reverse geocoding on first enrichment (Nominatim, cached per board)
- `boards_near(lat, lng, radius_m)` and `available_cities()` are the discovery entry points
- The frontend resolves city from: URL params → cookie → Vercel IP headers → default
- Timezone comes from city config (`lib/cities.ts`); events are always displayed in local time

---

## Recurring Events

Recurring events (farmers markets, open mics, support groups, AA meetings) are the most valuable long-lived content and the most fragile to manage.

Key decisions:
- `date_type = 'recurring'`, `recurrence_rule` stores RRULE (e.g. `FREQ=WEEKLY;BYDAY=WE`), `date_raw` stores the human text
- `expires_at = null` — never expires by date
- `staleness_days` defaults to the `recurring_event_staleness_days` config value (currently 90 days)
- Always included in the discovery feed regardless of date window — but `last_sighted_at` should be displayed to help users calibrate freshness
- Sorted separately from date-specific events in the feed; never mixed into the date-sorted upcoming list

**Recurring event matching ambiguity.** When a new sighting comes in for "Open Mic Night at Obsidian," `find_event_match()` may or may not link it to the existing recurring event record — it depends on name and location similarity. If it matches, the sighting is added to the existing event (confidence recomputes, `last_sighted_at` bumps). If it doesn't match, a new event record is created, which will eventually be caught by `run_dedup_pass()`. This is acceptable behavior — the conservative dedup policy (don't merge unless confident) applies to recurring events too. A duplicate listing of a recurring event is less harmful than a false merge of two different recurring events at the same venue.

Store hours-of-operation ("Open Mon–Sat 10am–6pm") look like recurring events to the model. The extraction prompt explicitly instructs to skip them. Diagnostic signal: a real recurring event has a *name*; hours of operation don't.

---

## Content Types

Not everything on a bulletin board is an event. The `content_type` field distinguishes:

| Type | Meaning |
|---|---|
| `event` | Something happening at a time and place |
| `announcement` | General news, fundraiser notice |
| `resource` | Ongoing service (clinic, support group, hotline) |
| `seeking` | Wanted post (rehearsal space, volunteers, roommates) |
| `advocacy` | Political or cause-oriented flyer |

The main discovery feed defaults to `content_type = 'event'`. Non-event content types are captured (they appear on every board) but not surfaced in the primary feed.

---

## Privacy Decisions

- **No personal contacts in public fields.** `events.contact` is public-facing only. Personal numbers and personal emails are never promoted out of `raw_extraction` or `enrichment_data`.
- **No address enrichment for minimal flyers.** A flyer with no address is withholding it deliberately. House shows, private venues, and sensitive community spaces depend on this. The pipeline must never add an address from a Facebook event or social post to a minimal flyer — it would be actively harmful.
- **Photos are short-lived.** Images deleted after 90 days; records deleted after 180 days. The knowledge they produce (events, sightings) is kept. `event_sightings` survives photo deletion — `photo_id` nulls out.
- **Contributors are minimal.** The `users` table holds only UUID (from Supabase auth) and email. No profiles, no reputation, no social layer. Purpose: rate limiting and abuse accountability, not identity.
- **Boards are never deleted.** Deactivation only. This protects the confidence model and the sighting history.

---

## Access Control

| Role | Capabilities |
|---|---|
| `anon` | SELECT on public views and tables; EXECUTE on `available_cities()`, `boards_near()` |
| `authenticated` | Same as anon + INSERT on `photos`, `event_reports`, `board_submissions` |
| `service_role` | Full access; used by Edge Functions |

TRUNCATE is revoked from `anon` and `authenticated` on all tables. Public views (`events_public`, `boards_public`, etc.) are the intended read interface; grants on base tables exist for cases where views don't cover a query (e.g. `boards_near()` joins directly).

`events_public` and other public views are `SECURITY DEFINER` — they run as the view owner and bypass RLS on underlying tables. This is intentional: the view's own WHERE clause (`is_active = true AND confidence_score >= min_confidence_display`) is the access control layer. RLS on the underlying `events` table would be redundant and is not relied upon for public access filtering.

The `event_board_locations` tell-me-more route uses a scoped key (`SUPABASE_TELL_ME_MORE_KEY`) with service role — the contact sanitization in the route handler is the real data policy enforcement, not the key scope.

---

## Configuration Table

All tunable thresholds live in the `config` table, not in code. No deploy needed to change them.

| Key | Default | Notes |
|---|---|---|
| `event_staleness_days` | 30 | One-off events |
| `recurring_event_staleness_days` | 90 | Farmers markets, open mics, support groups |
| `board_staleness_days` | 180 | |
| `org_staleness_days` | 365 | |
| `venue_staleness_days` | 365 | |
| `talent_staleness_days` | 365 | |
| `photo_retention_days` | 90 | Image files |
| `photo_record_retention` | 180 | DB records after image deletion |
| `max_daily_submissions_per_user` | 20 | Rate limiting |
| `min_confidence_display` | 0.3 | Extraction reliability gate; not a completeness check |
| `auto_approve_confidence` | 0.8 | Standard/detailed events |
| `auto_approve_confidence_minimal` | 0.55 | Minimal events (web verification absent by design) |
| `confidence_weight_extraction` | 0.4 | Must sum to 1.0 with sighting + verification |
| `confidence_weight_sighting` | 0.3 | |
| `confidence_weight_verification` | 0.3 | |
| `sighting_lambda` | 0.7 | n=1→0.50, n=2→0.75, n=3→0.88, n=5→0.97 |
| `trust_weight_venue_website` | 0.90 | Highest trust; future venue calendar ingestion source |
| `trust_weight_org_website` | 0.85 | |
| `trust_weight_local_calendar` | 0.80 | Alt-weekly, library calendar |
| `trust_weight_ticketing` | 0.75 | Eventbrite, Tixr, etc. |
| `trust_weight_news` | 0.70 | |
| `trust_weight_social` | 0.50 | Facebook, Instagram |

---

## What's Deliberately Not Built Yet

- Organizer accounts or direct event posting (social layer deferred until observational model proves out)
- Notification mechanism for follows and saved boards (schema supports it; delivery not built)
- `saved_boards` table (schema sketched in `idea-save-this-board.md`)
- `search_text` + `embedding` generation (schema columns exist; generation pipeline not built)
- pgTAP test suite (deferred post-MVP; most needed for `compute_event_confidence`, `find_event_match`, `apply_board_submission`, `merge_events`)
- Venue calendar scraping (venue_website is the highest-trust source and the natural next pipeline input after enrichment stabilizes)
- Monetization (candidates: freemium for organizers, local business sponsorships, civic partnerships)
