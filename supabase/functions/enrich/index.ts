// supabase/functions/enrich/index.ts
//
// Web search enrichment for extracted events.
// Runs on a cron schedule (every minute), processing one event per invocation.
//
// Queue state is tracked via events.enrichment_attempted_at:
//   null     = not yet attempted, eligible for enrichment
//   non-null = already attempted; reset to null by extract (via
//              maybe_reenqueue_enrichment) only when a new sighting
//              brings meaningful new search signal
//
// Model selection:
//   enrichment_attempt_count = 0  → Sonnet  (first pass: narrative writing,
//                                             full research, talent bios)
//   enrichment_attempt_count > 0  → Haiku   (re-enrichment: checking whether
//                                             new signal changes results)
//
// Design principle:
//   events holds what the flyer says.
//   Web search results are never written to events field columns.
//   Enrichment data lives in event_sightings.enrichment_data (JSONB),
//   where the presentation layer displays it as a distinct "found online"
//   section alongside — not instead of — what the flyer said.
//   Web sources feed confidence via event_verifications only.
//
// Rules:
//   - Never enrich flyer_style = 'minimal' events (intentionally sparse)
//   - Web-found data → event_sightings.enrichment_data only
//   - Web sources → event_verifications (feeds confidence trigger)
//   - events is never updated by this function (except via RPCs)
//   - DB trigger handles confidence recomputation after each verification insert

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_ENRICH_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// One event per invocation — stays well within the 150s function timeout.
// Raise this only once you've confirmed typical execution time under ~90s.
const MAX_EVENTS_PER_RUN = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EventRow {
  id: string;
  name: string;
  flyer_style: string | null;
  date_type: string;
  date_start: string | null;
  date_end: string | null;
  time_start: string | null;
  time_end: string | null;
  date_raw: string | null;
  location_name: string | null;
  location_address: string | null;
  description: string | null;
  contact: string | null;
  event_url: string | null;
  confidence_score: number;
  enrichment_attempt_count: number;
  organization_name: string | null;
  talent_names: string[];
}

// Mirrors lib/types/enrichment.ts — kept local to avoid a shared import
// across Edge Function / Next.js boundary. Keep in sync manually.

interface EnrichmentTalentLink {
  label: string;
  url: string;
}

interface EnrichmentTalent {
  name: string;
  bio: string | null;
  genre: string[] | null;
  links: EnrichmentTalentLink[];
}

interface EnrichmentFound {
  date_start: string | null;
  date_end: string | null;
  time_start: string | null;
  time_end: string | null;
  location_address: string | null;
  event_url: string | null;
  contact: string | null;
}

interface EnrichmentSource {
  url: string;
  label: string;
  source_type: SourceType;
  verified_fields: string[];
}

interface EnrichmentData {
  description: string | null;
  talent: EnrichmentTalent[];
  venue_context: string | null;
  ticket_url: string | null;
  sold_out: boolean | null;
  found: EnrichmentFound;
  sources: EnrichmentSource[];
}

type SourceType =
  | "venue_website"
  | "org_website"
  | "local_calendar"
  | "ticketing"
  | "news"
  | "social";

interface Coords {
  lat: number;
  lng: number;
}

interface UserLocation {
  type: "approximate";
  city?: string;
  region?: string;
  country?: string;
}

interface LocationContext {
  coords: Coords;
  userLocation: UserLocation | null;
}

interface BoardLocation {
  board_id: string;
  coords: Coords;
  userLocation: UserLocation | null;
}

// ---------------------------------------------------------------------------
// Trust weights — must match the config table values
// ---------------------------------------------------------------------------

const TRUST_WEIGHTS: Record<SourceType, number> = {
  venue_website: 0.90,
  org_website: 0.85,
  local_calendar: 0.80,
  ticketing: 0.75,
  news: 0.70,
  social: 0.50,
};

const VALID_SOURCE_TYPES = new Set<string>(Object.keys(TRUST_WEIGHTS));

function validSourceType(raw: string): SourceType {
  return VALID_SOURCE_TYPES.has(raw) ? (raw as SourceType) : "org_website";
}

// ---------------------------------------------------------------------------
// URL-pattern fallback classifier (used when Claude doesn't classify)
// ---------------------------------------------------------------------------

function classifySourceByUrl(url: string): SourceType {
  const u = url.toLowerCase();
  if (/eventbrite\.com|tixr\.com|brownpapertickets\.com|ticketweb\.com|axs\.com/.test(u))
    return "ticketing";
  if (/facebook\.com|instagram\.com/.test(u))
    return "social";
  if (
    /theolympian\.com|chronline\.com|thurstontalk\.com|olympiaweekly\.com|westsideseattle\.com|thestranger\.com|seattleweekly\.com|capitolhillseattle\.com/.test(u)
  )
    return "local_calendar";
  return "org_website";
}

// ---------------------------------------------------------------------------
// GeoJSON point parser
//
// Supabase/PostgREST returns GEOGRAPHY(POINT) as GeoJSON:
//   { "type": "Point", "coordinates": [lng, lat] }
// Note: GeoJSON coordinate order is [longitude, latitude].
// ---------------------------------------------------------------------------

function parseGeoPoint(raw: unknown): Coords | null {
  if (!raw) return null;
  try {
    const g: { type?: string; coordinates?: number[] } =
      typeof raw === "string" ? JSON.parse(raw) : raw;
    if (g?.type === "Point" && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
      return { lng: g.coordinates[0], lat: g.coordinates[1] };
    }
  } catch {
    // malformed
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reverse geocoding via Nominatim (OpenStreetMap)
// ---------------------------------------------------------------------------

async function reverseGeocode(coords: Coords): Promise<UserLocation | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${coords.lat}&lon=${coords.lng}&format=json&zoom=10`,
      {
        headers: {
          "User-Agent": "PostersUp/1.0 (postersup.org)",
          "Accept-Language": "en",
        },
      }
    );

    if (!res.ok) return null;

    const data = await res.json();
    const addr = data?.address ?? {};
    const city: string | undefined = addr.city ?? addr.town ?? addr.village;
    const region: string | undefined = addr.state;
    const country: string | undefined = addr.country_code?.toUpperCase();

    if (!city && !region) return null;

    return { type: "approximate", city, region, country };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Board location — DB lookup with geo cache
// ---------------------------------------------------------------------------

async function getBoardLocation(
  supabase: SupabaseClient,
  eventId: string
): Promise<BoardLocation | null> {
  const { data } = await supabase
    .from("event_sightings")
    .select("board_id, boards!inner ( geolocation, geo_city, geo_region, geo_country )")
    .eq("event_id", eventId)
    .not("board_id", "is", null)
    .neq("review_status", "rejected")
    .order("sighted_at", { ascending: false })
    .limit(1)
    .single();

  if (!data) return null;

  const board = (data as any).boards;
  const coords = parseGeoPoint(board?.geolocation);
  if (!coords) return null;

  const userLocation: UserLocation | null = board.geo_city
    ? {
        type: "approximate",
        city: board.geo_city,
        region: board.geo_region ?? undefined,
        country: board.geo_country ?? undefined,
      }
    : null;

  return { board_id: (data as any).board_id, coords, userLocation };
}

async function saveBoardGeo(
  supabase: SupabaseClient,
  boardId: string,
  geo: UserLocation
): Promise<void> {
  const { error } = await supabase
    .from("boards")
    .update({
      geo_city: geo.city ?? null,
      geo_region: geo.region ?? null,
      geo_country: geo.country ?? null,
    })
    .eq("id", boardId);

  if (error) {
    console.error(`saveBoardGeo failed for board ${boardId}:`, error);
  }
}

async function resolveLocationContext(
  supabase: SupabaseClient,
  eventId: string
): Promise<LocationContext | null> {
  const boardLoc = await getBoardLocation(supabase, eventId);
  if (!boardLoc) return null;

  if (boardLoc.userLocation) {
    return { coords: boardLoc.coords, userLocation: boardLoc.userLocation };
  }

  const geo = await reverseGeocode(boardLoc.coords);
  if (geo) await saveBoardGeo(supabase, boardLoc.board_id, geo);
  return { coords: boardLoc.coords, userLocation: geo };
}

// ---------------------------------------------------------------------------
// Enrichment system prompt
// ---------------------------------------------------------------------------

const ENRICHMENT_SYSTEM_PROMPT = `You are a web researcher for a community event discovery app. Your output is the "found online" section shown when a user taps "Tell me more" on an event card. Make it worth reading.

You receive partial data extracted from a physical bulletin board flyer. Search the web for context that would make someone decide to attend: who the artist is, what they sound like, what the venue is like, whether tickets are available.

LOCATION CONSTRAINT (hard):
The board's city is in the input. Only return results for events in that city.
A touring artist may have many upcoming shows — find the one in the board's city.
If you cannot confirm a show in that city, set date_start and location_address to null. Never report a date or address from another city.

TOUR PAGES:
If you land on a general tour or shows listing (artist.com/tour), do not stop there. Scan for a show in the board's city. If found, link to the deepest available URL — the specific event page or ticketing link, not the tour index. If not found, do a follow-up search for "[artist name] [city]" or "[artist name] [venue name]" before giving up.

CONTACT POLICY (hard):
Never include personal phone numbers or personal email addresses anywhere in your output. found.contact must be a public-facing URL only: venue website, org booking page. If only personal contacts are found, set contact to null.

DESCRIPTION:
Write 2-4 sentences a curious person would actually want to read. Draw on press coverage, organizer copy, artist bio, venue character — anything that makes this event feel real and specific. Not "Band X will perform at Venue Y." Something like what you'd read in a good alt-weekly preview. If you genuinely find nothing useful, set description to null. Do not write filler.

TALENT:
For each performer named in the input, search for:
  bio    — 1-2 sentences: who they are, what they sound like, anything distinctive
  genre  — array of genre tags (e.g. ["soul", "jazz", "folk"])
  links  — Bandcamp, Spotify, personal site (label: "Listen", "Website", "Instagram", etc.)
If a performer has no web presence, include them with null bio and empty links array.
Only include performers who appear in the input talent list — do not add others.

TALENT DISAMBIGUATION (hard):
Band and artist names are frequently shared by unrelated acts in other cities — a
bare name search can surface a same-named act instead of the one actually playing
this show. Before attaching bio/genre/links to a performer, confirm the web
presence belongs to the act in THIS show, not just an act with this name:
  - Prefer results reachable from, or corroborated by, the confirmed venue/event
    page, or from a source that references the board's city, the venue name, or
    another performer on this same bill. That link is the disambiguator.
  - A YouTube result is often a good tiebreaker even without a follow-up search:
    video titles, descriptions, or comments frequently name a specific venue,
    city, or date, which a bare Bandcamp or artist-website hit usually lacks. If
    a YouTube result already surfaced from a search you ran, weigh it before
    a link with no local/date signal at all.
  - If two same-named acts turn up and only one can be tied to this city, venue,
    bill, or date, use that one. If neither can be tied to this show, or only a
    same-named act elsewhere is found, prefer null bio and empty links over
    guessing. A wrong "Listen" link is a worse outcome than no link — it sends
    someone to the wrong band's music with false confidence.

VENUE CONTEXT:
Only populate if the web tells you something genuinely additive about the space itself: all-ages vs 21+, seated vs standing, known for good sound, coffee shop vs proper venue, capacity, parking, etc. Do not restate anything already in the description — if you covered the venue in the description paragraph, leave venue_context null. Do not restate the address or name. If you find nothing that the description didn't already cover, set venue_context to null.

TICKET INFO:
Set ticket_url to the deepest direct link found (Eventbrite event page, venue box office, etc.)
Set sold_out to true only if a ticketing page explicitly confirms it. Otherwise null.
Do not guess or infer sold-out status.

SOURCE TYPES (classify each source you cite):
  "venue_website"  — venue's own site or calendar
  "org_website"    — organizer's own website
  "local_calendar" — alt-weekly, civic calendar, library listings, local news events section
  "ticketing"      — Eventbrite, Tixr, Brown Paper Tickets, TicketWeb, AXS
  "news"           — local press article or preview
  "social"         — Facebook event, Instagram post

SOURCE LABELS:
label should be a short human-readable name for display: "Obsidian calendar", "Bandcamp", "Olympia Weekly", "Eventbrite". Not the raw URL.

VERIFIED FIELDS:
verified_fields must only list fields you confirmed for this specific event in this city.
A tour listing page confirms "name" only — not date_start or location_address — unless you found the specific local show on it. A venue calendar confirms name, date_start, location_address. A ticketing page for the specific show confirms name, date_start, time_start, location_address.

OUTPUT:
Your entire response must be a single JSON object and nothing else. No prose before it. No explanation after it. No markdown fences.
If you found nothing useful after searching: {"description":null,"talent":[],"venue_context":null,"ticket_url":null,"sold_out":null,"found":{},"sources":[]}

{
  "description": "2-4 sentences worth reading, or null",
  "talent": [
    {
      "name": "exact name from input",
      "bio": "1-2 sentences or null",
      "genre": ["tag1", "tag2"] or null,
      "links": [{"label": "Listen", "url": "https://..."}]
    }
  ],
  "venue_context": "what the web adds about this space, or null",
  "ticket_url": "direct ticket purchase link or null",
  "sold_out": true or null,
  "found": {
    "date_start": "YYYY-MM-DD or null",
    "date_end": "YYYY-MM-DD or null",
    "time_start": "HH:MM 24h or null",
    "time_end": "HH:MM 24h or null",
    "location_address": "full street address or null",
    "event_url": "direct link to this specific event or null",
    "contact": "public venue/org URL only — no personal contacts — or null"
  },
  "sources": [
    {
      "url": "https://...",
      "label": "Obsidian calendar",
      "source_type": "venue_website",
      "verified_fields": ["name", "date_start", "location_address"]
    }
  ]
}`;

// ---------------------------------------------------------------------------
// Claude enrichment call
// ---------------------------------------------------------------------------

async function callEnrichmentApi(
  event: EventRow,
  locationCtx: LocationContext | null
): Promise<{ failed: boolean; data: EnrichmentData | null }> {
  const userLocation = locationCtx?.userLocation ?? null;
  const knownLines: string[] = [];

  // Board location is the authoritative constraint — prepend it so the model
  // sees it before any event details.
  if (userLocation?.city) {
    const loc = [userLocation.city, userLocation.region, userLocation.country]
      .filter(Boolean)
      .join(", ");
    knownLines.push(`Board location: ${loc} — only return results for events in this area`);
  }

  knownLines.push(`Name: ${event.name}`);
  if (event.organization_name) knownLines.push(`Organizer: ${event.organization_name}`);
  if (event.talent_names.length) knownLines.push(`Talent: ${event.talent_names.join(", ")}`);
  if (event.date_start) knownLines.push(`Date: ${event.date_start}`);
  else if (event.date_raw) knownLines.push(`Date (as written on flyer): ${event.date_raw}`);
  else knownLines.push("Date: unknown");
  if (event.time_start) knownLines.push(`Time: ${event.time_start}`);
  if (event.location_name) knownLines.push(`Venue name: ${event.location_name}`);
  if (event.location_address) knownLines.push(`Address: ${event.location_address}`);
  if (event.event_url) knownLines.push(`Event URL: ${event.event_url}`);
  if (event.description) knownLines.push(`Description from flyer: ${event.description}`);

  const missingFields = [
    !event.date_start && "date",
    !event.time_start && "time",
    !event.location_address && "address",
    !event.event_url && "event URL",
  ].filter(Boolean);

  const userMessage =
    knownLines.join("\n") +
    (missingFields.length > 0
      ? `\n\nAlso looking for: ${missingFields.join(", ")}`
      : "");

  // Model selection: first enrichment pass gets Sonnet for narrative quality.
  // Re-enrichment passes get Haiku — they're checking whether new signal
  // changes results, not writing fresh prose.
  const model = event.enrichment_attempt_count === 0
    ? "claude-sonnet-4-6"
    : "claude-haiku-4-5";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: [
        {
          type: "text",
          text: ENRICHMENT_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        }
      ],
      messages: [{ role: "user", content: userMessage }],
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
        ...(userLocation ? { user_location: userLocation } : {}),
      }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`Anthropic API error for event ${event.id}:`, response.status, body);
    return { failed: true, data: null };
  }

  const data = await response.json();

  const textBlocks = (data.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text" && b.text);

  if (textBlocks.length === 0) return { failed: true, data: null };

  const raw = textBlocks.map((b) => b.text!).join("").trim();

  // Extract JSON robustly — Claude sometimes adds prose before or after the
  // JSON object despite instructions. Try three strategies in order:
  //   1. JSON inside a markdown code fence (anywhere in the response)
  //   2. The outermost { ... } object in the response
  //   3. The raw text as-is
  function extractJson(text: string): string {
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) return fenceMatch[1].trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) return text.slice(start, end + 1);
    return text.trim();
  }

  let parsed: any;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (e) {
    console.error(`JSON parse failed for event ${event.id}:`, e, "\nRaw:", raw.slice(0, 300));
    return { failed: true, data: null };
  }

  // Normalize to a safe EnrichmentData shape with defaults for required fields.
  return {
    failed: false,
    data: {
      description:   parsed.description   ?? null,
      talent:        Array.isArray(parsed.talent) ? parsed.talent : [],
      venue_context: parsed.venue_context ?? null,
      ticket_url:    parsed.ticket_url    ?? null,
      sold_out:      parsed.sold_out      ?? null,
      found:         parsed.found         ?? {},
      sources:       Array.isArray(parsed.sources) ? parsed.sources : [],
    },
  };
}

// ---------------------------------------------------------------------------
// Mark attempted
//
// Calls mark_enrichment_attempted() which stamps enrichment_attempted_at
// and increments enrichment_attempt_count atomically.
// Called after every enrichment attempt, successful or not.
// ---------------------------------------------------------------------------

async function markAttempted(supabase: SupabaseClient, eventId: string): Promise<void> {
  const { error } = await supabase.rpc("mark_enrichment_attempted", {
    p_event_id: eventId,
  });

  if (error) console.error(`mark_enrichment_attempted failed for event ${eventId}:`, error);
}

// ---------------------------------------------------------------------------
// Process a single event
// ---------------------------------------------------------------------------

async function processEvent(
  supabase: SupabaseClient,
  event: EventRow,
  locationCtx: LocationContext | null
): Promise<"enriched" | "skipped" | "failed"> {
  const { failed, data: result } = await callEnrichmentApi(event, locationCtx);

  // Mark attempted regardless of outcome — prevents retry storms on events
  // with no web footprint. extract resets enrichment_attempted_at via
  // maybe_reenqueue_enrichment() only when meaningful new signal arrives.
  await markAttempted(supabase, event.id);

  // Write enrichment status so we can distinguish API failures from
  // genuine empty results without re-queuing unnecessarily.
  await supabase
    .from("events")
    .update({ enrichment_status: failed ? "failed" : "complete" })
    .eq("id", event.id);

  if (failed) return "failed";

  // Determine whether we found anything worth storing.
  // Store if any meaningful content was returned — even a good description
  // with no sources is worth showing to users.
  const hasContent = result && (
    result.description !== null ||
    result.talent.length > 0 ||
    result.venue_context !== null ||
    result.ticket_url !== null ||
    result.sources.length > 0
  );

  // Write enrichment result to event_sightings.enrichment_data.
  // This is the only place web-found content is stored.
  // The presentation layer reads from here to show the "found online" section.
  await supabase
    .from("event_sightings")
    .update({
      enrichment_source: "web_search",
      enrichment_data: hasContent ? result : null,
    })
    .eq("event_id", event.id)
    .is("enrichment_source", null);

  // Flag the event so the card can show "Tell me more" without a round-trip.
  // Only set when there is genuine narrative content — a ticket URL or
  // gap-fill address alone doesn't warrant the label change.
  if (hasContent) {
    const hasNarrative = result && (
      result.description !== null ||
      result.talent.some(t => t.bio || (t.genre?.length ?? 0) > 0 || t.links.length > 0) ||
      result.venue_context !== null
    );

    if (hasNarrative) {
      await supabase
        .from("events")
        .update({ has_enrichment: true })
        .eq("id", event.id);
    }
  }

  if (!hasContent) return "skipped";

  // Insert one event_verifications row per source.
  // Each INSERT fires trg_verification_confidence → compute_event_confidence().
  // This is the only path by which enrichment affects the events table —
  // indirectly, via the confidence trigger.
  for (const source of result!.sources) {
    if (!source.url) continue;

    const sourceType = validSourceType(source.source_type ?? classifySourceByUrl(source.url));
    const verifiedFields: Record<string, boolean> = {};
    for (const field of source.verified_fields ?? []) verifiedFields[field] = true;

    const { error } = await supabase.from("event_verifications").insert({
      event_id: event.id,
      source_url: source.url,
      source_type: sourceType,
      trust_weight: TRUST_WEIGHTS[sourceType],
      verified_fields: verifiedFields,
      verified_by: "ai",
    });

    if (error && !error.message?.includes("unique")) {
      console.error(`event_verifications insert failed for ${event.id}:`, error);
    }
  }

  return "enriched";
}

// ---------------------------------------------------------------------------
// Queue query
//
// Selects events that:
//   - Are active and not minimal style
//   - Have never been enriched (enrichment_attempted_at IS NULL)
//   - Would benefit from enrichment (missing key fields or low confidence)
//
// Ordered oldest-first for FIFO queue behavior.
// Includes talent names via event_talent join for use in the search prompt.
// ---------------------------------------------------------------------------

async function fetchEventsNeedingEnrichment(
  supabase: SupabaseClient
): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from("events")
    .select(
      `id, name, flyer_style, date_type, date_start, date_end,
       time_start, time_end, date_raw,
       location_name, location_address,
       description, contact, event_url,
       confidence_score, enrichment_attempt_count,
       organizations ( name ),
       event_talent ( billing_position, talent ( name ) )`
    )
    .eq("is_active", true)
    .neq("flyer_style", "minimal")
    .is("enrichment_attempted_at", null)
    .or("confidence_score.lt.0.7,date_start.is.null,location_address.is.null,event_url.is.null")
    .order("created_at", { ascending: true })
    .limit(MAX_EVENTS_PER_RUN);

  if (error) throw error;

  return (data ?? []).map((row: any) => ({
    ...row,
    organization_name: row.organizations?.name ?? null,
    talent_names: (row.event_talent ?? [])
      .sort((a: any, b: any) =>
        (a.billing_position ?? 999) - (b.billing_position ?? 999)
      )
      .map((et: any) => et.talent?.name)
      .filter(Boolean),
    organizations: undefined,
    event_talent: undefined,
  }));
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let events: EventRow[];
  try {
    events = await fetchEventsNeedingEnrichment(supabase);
  } catch (err) {
    console.error("Failed to fetch events:", err);
    return new Response(JSON.stringify({ error: "DB query failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (events.length === 0) {
    return new Response(
      JSON.stringify({ enriched: 0, skipped: 0, failed: 0, message: "Queue empty" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  const counts = { enriched: 0, skipped: 0, failed: 0 };

  for (const event of events) {
    const locationCtx = await resolveLocationContext(supabase, event.id);
    const outcome = await processEvent(supabase, event, locationCtx);
    counts[outcome]++;
    console.log(
      `enrich: ${event.name} (attempt #${event.enrichment_attempt_count + 1}) → ${outcome}`
    );
  }

  return new Response(JSON.stringify(counts), {
    headers: { "Content-Type": "application/json" },
  });
});