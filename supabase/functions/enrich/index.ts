// supabase/functions/enrich/index.ts
//
// Web search enrichment for extracted events.
// Runs on a cron schedule (every minute), processing one event per invocation.
//
// Queue state is tracked via events.enrichment_attempted_at:
//   null     = not yet attempted, eligible for enrichment
//   non-null = already attempted; reset to null by extract when a new
//              sighting arrives so the event is re-queued with fresh data
//
// Design principle:
//   events holds what the flyer says.
//   Web search results are never written to events field columns.
//   Enrichment data lives in event_sightings.enrichment_data (JSONB),
//   where the presentation layer can display it as a distinct "more info"
//   layer with source attribution — not as authoritative flyer content.
//   Web sources feed confidence via event_verifications only.
//
// Rules:
//   - Never enrich flyer_style = 'minimal' events (intentionally sparse)
//   - Web-found data → event_sightings.enrichment_data only
//   - Web sources → event_verifications (feeds confidence trigger)
//   - events is never updated by this function (except enrichment_attempted_at)
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
  organization_name: string | null;
}

interface EnrichmentSource {
  url: string;
  source_type: SourceType;
  verified_fields: string[];
}

interface EnrichmentResult {
  found: {
    date_start?: string | null;
    date_end?: string | null;
    time_start?: string | null;
    time_end?: string | null;
    location_address?: string | null;
    event_url?: string | null;
    contact?: string | null;
    description?: string | null;
  };
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

// Bundles the board's raw coordinates with the derived UserLocation.
// Both travel together through the pipeline:
//   coords      — available for future haversine validation if we ever
//                 geocode found addresses
//   userLocation — passed to the web_search tool hint and prepended to
//                  the enrichment prompt as a city constraint
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
//
// Called only on a cache miss — when boards.geo_city is null.
// Nominatim's usage policy: descriptive User-Agent, max 1 req/sec.
// With MAX_EVENTS_PER_RUN = 1, we naturally stay within the rate limit.
// Returns null on failure; callers omit user_location rather than erroring.
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

    // A bare country code isn't useful enough to narrow search results.
    if (!city && !region) return null;

    return { type: "approximate", city, region, country };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Board location — DB lookup with geo cache
//
// Queries the most recent active sighting for this event to find its board,
// then returns both the board's coordinates and its cached UserLocation
// (boards.geo_city / geo_region / geo_country).
//
// Cache miss (geo columns null) → caller calls reverseGeocode + saveBoardGeo.
// Once written, every subsequent enrichment for any event on this board
// reads from cache without hitting Nominatim.
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
    // Non-fatal — next enrichment will try Nominatim again.
    console.error(`saveBoardGeo failed for board ${boardId}:`, error);
  }
}

// Returns coords + userLocation together so the full context travels as one unit.
async function resolveLocationContext(
  supabase: SupabaseClient,
  eventId: string
): Promise<LocationContext | null> {
  const boardLoc = await getBoardLocation(supabase, eventId);
  if (!boardLoc) return null;

  // Cache hit — no Nominatim call needed.
  if (boardLoc.userLocation) {
    return { coords: boardLoc.coords, userLocation: boardLoc.userLocation };
  }

  // Cache miss — reverse geocode and save for next time.
  const geo = await reverseGeocode(boardLoc.coords);
  if (geo) await saveBoardGeo(supabase, boardLoc.board_id, geo);
  return { coords: boardLoc.coords, userLocation: geo };
}

// ---------------------------------------------------------------------------
// Claude enrichment call
// ---------------------------------------------------------------------------

const ENRICHMENT_SYSTEM_PROMPT = `You are a web research assistant for a community event discovery app.

You receive partial event data extracted from a physical bulletin board flyer.
Search the web to find supporting information — full dates, venue address, event URL,
organizer website, description. This data will be shown to users as supplementary
"found online" context alongside what was on the flyer, not as a replacement for it.

CRITICAL RULES:
- Only report information confirmed by a web source. Never guess or invent.
- null is always better than wrong.
- LOCATION CONSTRAINT: the board location is included in the input. Only return results
  for events in that city/region. A touring artist may have many shows listed online —
  find the one in the board's city, not a show in another state.
- contact field: public-facing URLs ONLY — venue website, org booking page, org website.
  NEVER personal mobile numbers. NEVER personal email addresses. If you find only personal
  contacts, leave contact null.

TOUR AND SHOWS LISTINGS:
If you find a general upcoming shows or tour page (e.g. artist-website.com/shows or
/tour) rather than a page specific to one event, do NOT stop there. That page confirms
the artist is active but does not confirm the specific local show. You must go further:
- Scan the listing for a show in the board's city/region
- If you find one, report that specific date and venue in found.date_start /
  found.location_address, and set event_url to the deepest link available (the
  specific event page or ticketing link for that show, not the tour index)
- If you cannot identify a show in the board's city on that listing, leave
  date_start and location_address null — do not report dates for other cities
- A follow-up search for "[artist name] [city]" or "[artist name] [venue name]"
  is a good use of a remaining search if the tour page was ambiguous

VERIFIED FIELDS:
verified_fields must only list fields you confirmed for THIS specific event in THIS city.
- A tour listing page confirms "name" only — not date_start or location_address —
  unless you found the specific local show on it.
- A venue calendar page confirms name, date_start, location_address, location_name.
- A ticketing page for the specific show confirms name, date_start, time_start,
  location_address, price_raw (if present), age_restriction (if present).
Do not include a field in verified_fields unless you are certain it matches this
specific local event, not some other show by the same artist.

SOURCE TYPES (classify each source you find):
  "venue_website"  — the venue's own site or calendar (highest trust)
  "org_website"    — the organizer's own website
  "local_calendar" — alt-weekly, civic calendar, library listings, local news events section
  "ticketing"      — Eventbrite, Tixr, Brown Paper Tickets, TicketWeb, AXS
  "news"           — local press article about the event
  "social"         — Facebook event page, Instagram post

OUTPUT — your entire response must be a single JSON object and nothing else.
No prose before it. No explanation after it. No markdown fences. No "Researcher's Note".
If you found nothing, output exactly: {"found": {}, "sources": []}
{
  "found": {
    "date_start": "YYYY-MM-DD or null",
    "date_end": "YYYY-MM-DD or null",
    "time_start": "HH:MM (24h) or null",
    "time_end": "HH:MM (24h) or null",
    "location_address": "full street address or null",
    "event_url": "direct link to this specific event or null",
    "contact": "public venue/org URL only — no personal contacts — or null",
    "description": "1-2 sentence description or null"
  },
  "sources": [
    {
      "url": "https://...",
      "source_type": "venue_website | org_website | local_calendar | ticketing | news | social",
      "verified_fields": ["name", "date_start", "location_address"]
    }
  ]
}

If you find nothing useful after searching, return: {"found": {}, "sources": []}`;

async function callEnrichmentApi(
  event: EventRow,
  locationCtx: LocationContext | null
): Promise<EnrichmentResult | null> {
  const userLocation = locationCtx?.userLocation ?? null;
  const knownLines: string[] = [];

  // Board location comes first — it is the authoritative constraint.
  // Claude should find the show in this city, not a different show by
  // the same artist or under the same name elsewhere.
  if (userLocation?.city) {
    const loc = [userLocation.city, userLocation.region, userLocation.country]
      .filter(Boolean)
      .join(", ");
    knownLines.push(`Board location: ${loc} — only return results for events in this area`);
  }

  knownLines.push(`Name: ${event.name}`);
  if (event.organization_name) knownLines.push(`Organizer: ${event.organization_name}`);
  if (event.date_start) knownLines.push(`Date: ${event.date_start}`);
  else if (event.date_raw) knownLines.push(`Date (as written on flyer): ${event.date_raw}`);
  else knownLines.push("Date: unknown");
  if (event.time_start) knownLines.push(`Time: ${event.time_start}`);
  if (event.location_name) knownLines.push(`Venue name: ${event.location_name}`);
  if (event.location_address) knownLines.push(`Address: ${event.location_address}`);
  if (event.event_url) knownLines.push(`Event URL: ${event.event_url}`);
  if (event.description) knownLines.push(`Description: ${event.description}`);

  const missingFields = [
    !event.date_start && "date",
    !event.time_start && "time",
    !event.location_address && "address",
    !event.event_url && "event URL",
    !event.contact && "organizer/venue website",
    !event.description && "description",
  ].filter(Boolean);

  const userMessage =
    knownLines.join("\n") +
    (missingFields.length > 0
      ? `\n\nLooking for: ${missingFields.join(", ")}`
      : "\n\nAll key fields are present; find sources that confirm this event.");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
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
    return null;
  }

  const data = await response.json();

  // Web search responses contain a mix of block types:
  //   "text"                   — Claude's final answer (what we want)
  //   "server_tool_use"        — the search query Claude issued
  //   "web_search_tool_result" — raw results from the search API
  const textBlocks = (data.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text" && b.text);

  if (textBlocks.length === 0) return null;

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

  try {
    return JSON.parse(extractJson(raw)) as EnrichmentResult;
  } catch (e) {
    console.error(`JSON parse failed for event ${event.id}:`, e, "\nRaw:", raw.slice(0, 300));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mark attempted
//
// Called after every enrichment attempt, successful or not.
// Removes the event from the queue until a new sighting resets the flag.
// ---------------------------------------------------------------------------

async function markAttempted(supabase: SupabaseClient, eventId: string): Promise<void> {
  const { error } = await supabase
    .from("events")
    .update({ enrichment_attempted_at: new Date().toISOString() })
    .eq("id", eventId);

  if (error) console.error(`markAttempted failed for event ${eventId}:`, error);
}

// ---------------------------------------------------------------------------
// Process a single event
// ---------------------------------------------------------------------------

async function processEvent(
  supabase: SupabaseClient,
  event: EventRow,
  locationCtx: LocationContext | null
): Promise<"enriched" | "skipped" | "failed"> {
  const result = await callEnrichmentApi(event, locationCtx);

  // Mark attempted regardless of outcome — prevents retry storms on events
  // with no web footprint. extract resets this when a new sighting arrives.
  await markAttempted(supabase, event.id);

  // Write enrichment result to event_sightings.enrichment_data.
  // This is the only place web-found field values are stored.
  // The presentation layer reads from here to show a distinct "found online"
  // section — separate from what the flyer said, with source attribution.
  await supabase
    .from("event_sightings")
    .update({
      enrichment_source: "web_search",
      enrichment_data: result?.sources?.length ? result : null,
    })
    .eq("event_id", event.id)
    .is("enrichment_source", null);

  if (!result) return "failed";
  if (!result.sources.length) return "skipped";

  // Insert one event_verifications row per source.
  // Each INSERT fires trg_verification_confidence → compute_event_confidence().
  // This is the only path by which enrichment affects the events table —
  // indirectly, via the confidence trigger.
  for (const source of result.sources) {
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
       confidence_score,
       organizations ( name )`
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
    organizations: undefined,
  }));
}

// ---------------------------------------------------------------------------
// Main handler
//
// Called by the Supabase Cron job every minute. No request body needed.
// Auth is handled by Supabase JWT (Enforce JWT enabled in function settings).
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
  }

  console.log(
    `enrich: processed ${events.length} events — ` +
      `enriched=${counts.enriched} skipped=${counts.skipped} failed=${counts.failed}`
  );

  return new Response(JSON.stringify(counts), {
    headers: { "Content-Type": "application/json" },
  });
});