// lib/types/enrichment.ts
//
// Shared type definitions for enrichment data produced by the enrich
// Edge Function and consumed by the tell-me-more API route and EventCard.
//
// Shape overview:
//   EnrichmentData       — top-level; stored in event_sightings.enrichment_data
//   EnrichmentFound      — structured fields; feeds event_verifications / confidence
//   EnrichmentTalent     — per-performer context found online
//   EnrichmentSource     — one web source; feeds event_verifications and attribution UI
//
// Design notes:
//   - description lives at the top level, not inside found. It is narrative
//     content for display, not a structured field for confidence computation.
//   - found contains only fields relevant to confidence: date, time, address,
//     URLs. The enrich prompt no longer asks for a one-liner description inside
//     found — that was gap-filling; the top-level description is the real thing.
//   - sources carries a human-readable label ("Obsidian calendar") for display
//     alongside the existing source_type used for trust weight lookup.
//   - All fields are nullable. The card and API route must handle partial data
//     gracefully — a community potluck may produce talent: [] and venue_context: null
//     with only a ticket_url, or nothing at all.

// ── Structured fields (confidence pipeline) ────────────────────────────────

export interface EnrichmentFound {
  date_start:       string | null   // YYYY-MM-DD
  date_end:         string | null
  time_start:       string | null   // HH:MM 24h
  time_end:         string | null
  location_address: string | null
  event_url:        string | null
  contact:          string | null   // public-facing URL only; no personal contacts
}

export type SourceType =
  | 'venue_website'
  | 'org_website'
  | 'local_calendar'
  | 'ticketing'
  | 'news'
  | 'social'

// ── Per-source attribution ─────────────────────────────────────────────────

export interface EnrichmentSource {
  url:             string
  label:           string           // human-readable: "Obsidian calendar", "Bandcamp"
  source_type:     SourceType       // venue_website | org_website | local_calendar |
                                    // ticketing | news | social
  verified_fields: string[]         // fields this source confirmed; feeds event_verifications
}

// ── Per-talent context ────────────────────────────────────────────────────

export interface EnrichmentTalentLink {
  label: string   // "Listen", "Website", "Tickets"
  url:   string
}

export interface EnrichmentTalent {
  name:   string
  bio:    string | null             // 1-2 sentences: who they are, what they sound like
  genre:  string[] | null
  links:  EnrichmentTalentLink[]    // Bandcamp, Spotify, personal site, etc.
}

// ── Top-level enrichment data ─────────────────────────────────────────────

export interface EnrichmentData {
  // Narrative description: the thing worth reading. Synthesized from press,
  // organizer copy, or artist context. Always shown when present, regardless
  // of whether the flyer had its own description — it should be richer.
  description:   string | null

  // Per-performer context. Empty array when no talent found or no info available.
  talent:        EnrichmentTalent[]

  // What kind of space this is — vibe, capacity, standing vs seated, etc.
  // Only populated when the web adds something the flyer didn't say.
  venue_context: string | null

  // Direct ticket link if found. Separate from event_url because it may be
  // a ticketing page discovered via enrichment rather than printed on the flyer.
  ticket_url:    string | null

  // Whether tickets are sold out, if determinable from a ticketing page.
  sold_out:      boolean | null

  // Structured fields for confidence computation. Kept nested so the
  // presentation layer can ignore them entirely.
  found:         EnrichmentFound

  // Sources for attribution UI and confidence pipeline.
  sources:       EnrichmentSource[]
}

// ── Tell-me-more API response ─────────────────────────────────────────────
//
// Returned by /api/events/[id]/tell-me-more.
// Replaces the previous TellMeMoreData shape in EventCard.

export interface BoardLocation {
  board_id:                     string
  location_name:                string | null
  board_description:            string | null
  last_seen_at:                 string
  lat:                          number
  lng:                          number
  managed_by:                   string | null
  requires_entry_to_photograph: boolean | null
}

export interface TellMeMoreData {
  boards:        BoardLocation[]
  enrichment:    EnrichmentData | null   // null when no enrichment attempted or nothing found
}

// Note: verifications is removed from TellMeMoreData. The confidence score
// and breakdown are already on the event row in events_public; surfacing
// raw verification URLs in the expansion was never implemented in the card.
// Attribution is now handled via enrichment.sources with human-readable labels.