import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { claimAndDispatch } from "../_shared/claimAndDispatch.ts";

// EdgeRuntime is a Supabase Edge Runtime global — not available in standard Deno.
// waitUntil() keeps the function alive after the response is sent.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_EXTRACT_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EXTRACT_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/extract`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ── Types ──────────────────────────────────────────────────────────────────

type SupabaseClient = ReturnType<typeof createClient>;

// Request body from the upload client.
// photo_path and capture_date come from the upload page after EXIF extraction.
interface RequestBody {
  photo_path?:   string;
  lat?:          number;
  lng?:          number;
  capture_date?: string;
  board_id?:     string;
  // Present only on internal dispatch calls from claimAndDispatch (either
  // the browser-triggered path below, or the extract-drain cron backstop).
  // Mutually exclusive with photo_path — see the branch at the top of the
  // request handler.
  photo_id?:     string;
}

// Shape of each item returned by the Claude extraction prompt.
// Mirrors the extraction system prompt output schema — keep in sync.
// Arrays (tags, accessibility, talent) should always be present per the prompt;
// the ?? [] safety nets in the handler guard against incomplete model output.
interface ExtractedTalent {
  name:             string;
  role:             string | null;
  billing_position: number | null;
}

interface ExtractedItem {
  name:             string;
  content_type:     "event" | "announcement" | "resource" | "seeking" | "advocacy" | null;
  flyer_style:      "minimal" | "standard" | "detailed" | null;
  event_category:   string | null;
  tags:             string[];
  date_type:        "specific" | "recurring" | "approximate" | "unknown";
  date_start:       string | null;  // YYYY-MM-DD
  date_end:         string | null;
  time_start:       string | null;  // HH:MM 24h
  time_end:         string | null;
  recurrence_rule:  string | null;  // RRULE string
  date_raw:         string | null;
  location_name:    string | null;
  location_address: string | null;
  description:      string | null;
  contact:          string | null;  // public-facing URL only
  event_url:        string | null;
  price_raw:        string | null;
  is_free:          boolean | null;
  age_restriction:  string | null;
  is_public:        boolean | null;
  language:         string | null;  // BCP 47
  is_outdoor:       boolean | null;
  accessibility:    string[];
  masks_required:   string | null;
  rsvp_required:    boolean | null;
  rsvp_url:         string | null;
  organization:     string | null;
  confidence:       number;         // 0–1; → event_sightings.extraction_confidence
  confidence_note:  string | null;
  field_confidence: {               // per-field readability scores for dedup decisions
    name:     number;
    date:     number;
    location: number;
  } | null;
  talent:           ExtractedTalent[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Claude occasionally writes prose before the JSON array despite instructions.
// Try three strategies in order:
//   1. JSON inside a markdown code fence (anywhere in the response)
//   2. The outermost [ ... ] array in the response
//   3. The raw text as-is (let JSON.parse produce a useful error)
function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = text.indexOf("[");
  const end   = text.lastIndexOf("]");
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

// Deterministic date-consistency check — catches internally inconsistent
// date readings (e.g. "Wednesday July 11th 2026" when July 11, 2026 is
// actually a Saturday) for free, with no reliance on the vision model's
// own day-of-week arithmetic, which LLMs are unreliable at. A mismatch
// here is provably wrong, not a judgment call — the flyer's stated
// weekday and its calendar date are supposed to be the same fact stated
// two ways, not two independent observations.
//
// Returns a low confidence on mismatch, or null when there's nothing to
// check (no day-of-week word in date_raw, or no date_start). null flows
// into find_event_match() as "trusted" (see v_date_trusted in the 8-arg
// overload in schema_current.sql) — this only ever downgrades trust,
// never upgrades it, and never overrides a lower field_confidence.date
// the model may have already reported for an unrelated legibility reason
// (see the Math.min composition where this is used below).
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function dayOfWeekConsistencyConfidence(
  dateRaw: string | null,
  dateStart: string | null,
): number | null {
  if (!dateRaw || !dateStart) return null;

  const stated = DAY_NAMES.find(day => dateRaw.toLowerCase().includes(day));
  if (!stated) return null;

  const actual = DAY_NAMES[new Date(dateStart + "T00:00:00Z").getUTCDay()];
  return actual === stated ? null : 0.3;
}

// Reverse geocodes a board location at street level (zoom=17).
// Populates both the human-readable description ("4th Ave E, Olympia")
// and the city/neighborhood/region/country cache used by the enrich function
// and the "Seattle - Fremont" style area picker.
// Non-blocking — if Nominatim fails, board is created without description.
async function reverseGeocodeBoard(lat: number, lng: number): Promise<{
  description: string | null
  geo_city: string | null
  geo_region: string | null
  geo_country: string | null
  geo_neighborhood: string | null
} | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=17`,
      {
        headers: {
          "User-Agent": "PostersUp/1.0 (postersup.org)",
          "Accept-Language": "en",
        },
      }
    )
    if (!res.ok) return null
    const data = await res.json()
    const addr = data?.address ?? {}
    const road    = addr.road ?? addr.pedestrian ?? addr.path ?? null
    const city    = addr.city ?? addr.town ?? addr.village ?? null
    const region  = addr.state ?? null
    const country = addr.country_code?.toUpperCase() ?? null
    // Nominatim's neighbourhood-tier field name varies by locale/region --
    // try the common ones in order of specificity. This is opportunistic:
    // frequently absent even when city/region resolve fine, and that's
    // expected (see the column comment on boards.geo_neighborhood), not
    // an error worth logging.
    const neighborhood = addr.neighbourhood ?? addr.suburb ?? addr.quarter ?? addr.city_district ?? null
    const description = [road, city].filter(Boolean).join(", ") || null
    return { description, geo_city: city, geo_region: region, geo_country: country, geo_neighborhood: neighborhood }
  } catch {
    return null
  }
}

// Looks up an organization by canonical name, creates it if absent,
// and bumps last_active_at on every call. Returns the id or null on error.
async function upsertOrganization(
  name: string,
  supabase: SupabaseClient,
): Promise<string | null> {
  const canonical = name.toLowerCase().trim();

  const { data: existing, error: lookupError } = await supabase
    .from("organizations")
    .select("id")
    .eq("canonical_name", canonical)
    .maybeSingle();

  if (lookupError) {
    console.warn(`Org lookup failed for "${name}":`, lookupError.message);
    return null;
  }

  if (existing) {
    await supabase
      .from("organizations")
      .update({ last_active_at: new Date().toISOString() })
      .eq("id", existing.id);
    return existing.id;
  }

  const { data: newOrg, error: insertError } = await supabase
    .from("organizations")
    .insert({
      name,
      canonical_name: canonical,
      last_active_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertError) {
    console.warn(`Org creation failed for "${name}":`, insertError.message);
    return null;
  }

  return newOrg?.id ?? null;
}

// Looks up a talent record by canonical name, creates it if absent,
// and bumps last_active_at on every call. Returns the id or null on error.
// The event_talent link is written by the caller — it carries event-specific
// fields (role, billing_position) that belong at the call site.
async function upsertTalent(
  name: string,
  supabase: SupabaseClient,
): Promise<string | null> {
  const canonical = name.toLowerCase().trim();

  const { data: existing, error: lookupError } = await supabase
    .from("talent")
    .select("id")
    .eq("canonical_name", canonical)
    .maybeSingle();

  if (lookupError) {
    console.warn(`Talent lookup failed for "${name}":`, lookupError.message);
    return null;
  }

  if (existing) {
    await supabase
      .from("talent")
      .update({ last_active_at: new Date().toISOString() })
      .eq("id", existing.id);
    return existing.id;
  }

  const { data: newTalent, error: insertError } = await supabase
    .from("talent")
    .insert({
      name,
      canonical_name: canonical,
      last_active_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertError) {
    console.warn(`Talent creation failed for "${name}":`, insertError.message);
    return null;
  }

  return newTalent?.id ?? null;
}

// ── Background extraction ──────────────────────────────────────────────────
//
// Everything slow: photo download, Claude call, all DB writes.
// Invoked via dispatchExtraction() below, which is always itself wrapped in
// EdgeRuntime.waitUntil() by its caller — runExtraction has no timing
// contract of its own to honor, it just runs to completion.
//
// lat/lng are no longer passed in from the original upload request — they're
// derived here from the resolved board via board_lat_lng(), since whichever
// invocation ends up running this (the original request, claim_pending_photos
// handing the row to a later request, or the cron backstop) may not be the
// one that had the original request body available.

async function runExtraction(
  photoId: string,
  photo_path: string,
  capturedAt: string,
  resolvedBoardId: string | null,
  supabase: SupabaseClient,
): Promise<void> {
  try {

    // ── Download photo ──────────────────────────────────────────────────────
    const { data: photoBlob, error: downloadError } = await supabase.storage
      .from("photos-raw")
      .download(photo_path);

    if (downloadError || !photoBlob) {
      throw new Error(`Photo download failed: ${downloadError?.message}`);
    }

    const arrayBuffer = await photoBlob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    let base64 = "";
    const chunkSize = 8192;
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      base64 += String.fromCharCode(...uint8Array.subarray(i, i + chunkSize));
    }
    base64 = btoa(base64);
    const mimeType = photoBlob.type || "image/jpeg";

    // ── Board context + coordinates ─────────────────────────────────────────
    let boardDescription: string | null = null;
    let knownEvents: { name: string; date_start: string | null }[] | null = null;
    let lat: number | null = null;
    let lng: number | null = null;

    if (resolvedBoardId) {
      const { data: board, error: boardFetchError } = await supabase
        .from("boards")
        .select("description")
        .eq("id", resolvedBoardId)
        .single();

      if (boardFetchError) {
        console.warn(`Could not fetch board context: ${boardFetchError.message}`);
      } else {
        boardDescription = board?.description ?? null;
      }

      // Derived from the board rather than passed in — see the function
      // header note on why this can't rely on request-scoped lat/lng anymore.
      const { data: coords, error: coordsError } = await supabase.rpc("board_lat_lng", {
        p_board_id: resolvedBoardId,
      });

      if (coordsError) {
        console.warn(`Could not fetch board coordinates: ${coordsError.message}`);
      } else if (coords?.[0]) {
        lat = coords[0].lat;
        lng = coords[0].lng;
      }

      const { data: flyers, error: flyersError } = await supabase
        .from("board_flyers")
        .select("events(name, date_start)")
        .eq("board_id", resolvedBoardId)
        .eq("is_active", true)
        .order("last_seen_at", { ascending: false })
        .limit(10);

      if (flyersError) {
        console.warn(`Could not fetch known board events: ${flyersError.message}`);
      } else if (flyers?.length) {
        knownEvents = flyers
          .map((f: any) => ({
            name: f.events?.name,
            date_start: f.events?.date_start,
          }))
          .filter((e: any) => e.name);
      }
    }

    // ── Call Claude ─────────────────────────────────────────────────────────
    const userMessage = [
      `Photo taken: ${capturedAt.split("T")[0]}`,
      `Board location: ${boardDescription ?? "unknown"}`,
      `Known events on this board as of last photo: ${knownEvents ? JSON.stringify(knownEvents) : "none"}`,
      "",
      "Extract all items from this bulletin board photo.",
    ].join("\n");

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 16000,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          }
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mimeType, data: base64 },
              },
              { type: "text", text: userMessage },
            ],
          },
        ],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      throw new Error(`Claude API error ${claudeRes.status}: ${err}`);
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text ?? "";

    let extractedItems: ExtractedItem[];
    try {
      extractedItems = JSON.parse(extractJson(rawText)) as ExtractedItem[];
      if (!Array.isArray(extractedItems)) throw new Error("Response was not a JSON array");
    } catch (parseErr: any) {
      console.error("Claude response parse failed. Raw text:", rawText.slice(0, 500));
      throw new Error(`Failed to parse extraction response: ${parseErr.message}`);
    }

    console.log(`Claude extracted ${extractedItems.length} items for photo ${photoId}`);

    // ── Write extracted items to DB ─────────────────────────────────────────
    for (const item of extractedItems) {
      try {
        if (!item.name) {
          console.warn(`Skipping unnamed item in photo ${photoId}`);
          continue;
        }

        let eventId: string | null = null;
        let matchType: string = "none";

        // ── Event matching ──────────────────────────────────────────────────
        // Top-billed act: prefer explicit billing_position = 1, fall back to
        // the first talent entry. Passed to find_event_match() as the talent
        // anchor signal — a stable identity even when the AI names the event
        // differently across extractions of the same flyer.
        const topAct: string | null =
          item.talent.find(t => t.billing_position === 1)?.name
          ?? item.talent[0]?.name
          ?? null;

        // Date confidence passed to find_event_match(): the more pessimistic
        // of (a) the model's own field_confidence.date self-report (legibility
        // only — see FIELD CONFIDENCE in system-prompt.ts) and (b) a
        // deterministic day-of-week/calendar-date consistency check (catches
        // provably wrong dates a legible-looking read can still produce — see
        // dayOfWeekConsistencyConfidence above). Either signal alone can
        // downgrade trust; neither can upgrade it. null (both absent) means
        // find_event_match() treats the date as trusted, same as before this
        // check existed.
        const consistencyConfidence = dayOfWeekConsistencyConfidence(item.date_raw, item.date_start);
        const dateConfidenceCandidates = [item.field_confidence?.date, consistencyConfidence]
          .filter((v): v is number => v != null);
        const dateConfidence = dateConfidenceCandidates.length > 0
          ? Math.min(...dateConfidenceCandidates)
          : null;

        const { data: match, error: matchError } = await supabase.rpc("find_event_match", {
          p_name:            item.name,
          p_date_start:      item.date_start ?? null,
          p_location_name:   item.location_name ?? null,
          p_board_lat:       lat ?? null,
          p_board_lng:       lng ?? null,
          p_event_url:       item.event_url ?? null,
          p_talent_name:     topAct,
          p_date_confidence: dateConfidence,
        });

        if (matchError) {
          console.warn(`Event match check failed for "${item.name}":`, matchError.message);
        } else if (match?.match_id) {
          eventId = match.match_id;
          matchType = match.match_type;
        }

        // ── Organization lookup / create ────────────────────────────────────
        const organizationId: string | null = item.organization
          ? await upsertOrganization(item.organization, supabase)
          : null;

        // ── Create or update event ──────────────────────────────────────────
        if (!eventId) {
          const { data: newEvent, error: eventInsertError } = await supabase
            .from("events")
            .insert({
              name: item.name,
              organization_id: organizationId,
              content_type: item.content_type ?? "event",
              event_category: item.event_category ?? null,
              tags: item.tags ?? [],
              flyer_style: item.flyer_style ?? null,
              date_type: item.date_type ?? "unknown",
              date_start: item.date_start ?? null,
              date_end: item.date_end ?? null,
              time_start: item.time_start ?? null,
              time_end: item.time_end ?? null,
              recurrence_rule: item.recurrence_rule ?? null,
              date_raw: item.date_raw ?? null,
              location_name: item.location_name ?? null,
              location_address: item.location_address ?? null,
              description: item.description ?? null,
              contact: item.contact ?? null,
              event_url: item.event_url ?? null,
              price_raw: item.price_raw ?? null,
              is_free: item.is_free ?? null,
              age_restriction: item.age_restriction ?? null,
              is_public: item.is_public ?? null,
              language: item.language ?? null,
              is_outdoor: item.is_outdoor ?? null,
              accessibility: item.accessibility ?? [],
              masks_required: item.masks_required ?? null,
              rsvp_required: item.rsvp_required ?? null,
              rsvp_url: item.rsvp_url ?? null,
              first_sighted_at: capturedAt,
              last_sighted_at: capturedAt,
            })
            .select("id")
            .single();

          if (eventInsertError) {
            console.error(`Event insert failed for "${item.name}":`, JSON.stringify(eventInsertError));
            continue;
          }

          eventId = newEvent?.id ?? null;
        } else {
          // Existing event — merge in new information, bump observation timestamp.
          // Field update rules:
          //   Arrays (tags, accessibility): union-merge, deduplicated
          //   Booleans (is_free, is_public, is_outdoor, rsvp_required): use != null
          //     check so that false is not treated as "no value" and skipped
          //   Strings: only update when incoming value is non-null/non-empty
          const { data: existing, error: fetchExistingError } = await supabase
            .from("events")
            .select("tags, accessibility")
            .eq("id", eventId)
            .single();

          if (fetchExistingError) {
            console.warn(`Could not fetch existing event data for merge (id: ${eventId}):`, fetchExistingError.message);
          }

          const { error: updateError } = await supabase
            .from("events")
            .update({
              last_sighted_at: capturedAt,
              updated_at: capturedAt,
              // Arrays: union-merge across sightings
              tags: [...new Set([...(existing?.tags ?? []), ...(item.tags ?? [])])],
              accessibility: [
                ...new Set([
                  ...(existing?.accessibility ?? []),
                  ...(item.accessibility ?? []),
                ]),
              ],
              // Strings: last non-null value wins
              ...(item.event_category  && { event_category:  item.event_category }),
              ...(item.age_restriction && { age_restriction: item.age_restriction }),
              ...(item.language        && { language:        item.language }),
              ...(item.masks_required  && { masks_required:  item.masks_required }),
              ...(item.price_raw       && { price_raw:       item.price_raw }),
              ...(item.event_url       && { event_url:       item.event_url }),
              ...(item.flyer_style     && { flyer_style:     item.flyer_style }),
              // Booleans: != null so false is not silently skipped
              ...(item.is_free    != null && { is_free:    item.is_free }),
              ...(item.is_outdoor != null && { is_outdoor: item.is_outdoor }),
              ...(item.is_public  != null && { is_public:  item.is_public }),
              ...(item.rsvp_required != null && { rsvp_required: item.rsvp_required }),
              // enrichment_attempted_at is NOT reset here unconditionally.
              // maybe_reenqueue_enrichment() below decides whether to re-queue
              // based on verification status and whether new search signal arrived.
            })
            .eq("id", eventId);

          if (updateError) {
            console.warn(`Event merge failed for "${item.name}" (id: ${eventId}):`, updateError.message);
          }

          // Re-queue enrichment only if it would produce a different result.
          // Passes all four signal fields so the function can decide whether
          // any of them represent genuinely new search signal worth re-running.
          const { error: reenqueueError } = await supabase.rpc(
            "maybe_reenqueue_enrichment",
            {
              p_event_id:        eventId,
              p_new_event_url:   item.event_url     ?? null,
              p_new_location:    item.location_name ?? null,
              p_new_date_start:  item.date_start    ?? null,
              p_new_description: item.description   ?? null,
            }
          );

          if (reenqueueError) {
            console.warn(`maybe_reenqueue_enrichment failed for "${item.name}":`, reenqueueError.message);
          }
        }

        if (!eventId) {
          console.warn(`No event ID after insert for "${item.name}" — skipping sighting`);
          continue;
        }

        // ── Sighting ────────────────────────────────────────────────────────
        const { error: sightingError } = await supabase.from("event_sightings").insert({
          event_id: eventId,
          photo_id: photoId,
          board_id: resolvedBoardId,
          raw_extraction: item,
          extraction_confidence: item.confidence ?? 0.5,
          flyer_style: item.flyer_style ?? null,
          match_type: matchType === "none" ? "new" : matchType,
          sighted_at: capturedAt,
        });

        if (sightingError) {
          console.warn(`Sighting insert failed for "${item.name}":`, sightingError.message);
        }

        // ── Board flyer upsert ──────────────────────────────────────────────
        if (resolvedBoardId) {
          const { error: flyerError } = await supabase.from("board_flyers").upsert(
            {
              board_id: resolvedBoardId,
              event_id: eventId,
              last_seen_at: capturedAt,
              is_active: true,
              removed_at: null,
            },
            { onConflict: "board_id,event_id" },
          );

          if (flyerError) {
            console.warn(`Board flyer upsert failed for "${item.name}":`, flyerError.message);
          }
        }

        // ── Talent confirmation ─────────────────────────────────────────────
        // For matched events only: check incoming names against existing
        // unconfirmed talent rows and flip confirmed = true on matches.
        // Called before talent upserts so we only confirm rows that existed
        // before this sighting, not ones we're about to create from this photo.
        if (matchType !== "none") {
          const incomingTalentNames = item.talent
            .map(t => t.name)
            .filter(name => name.length > 0);

          if (incomingTalentNames.length > 0) {
            const { error: confirmError } = await supabase.rpc(
              "confirm_talent_from_sighting",
              {
                p_event_id:              eventId,
                p_incoming_talent_names: incomingTalentNames,
              }
            );

            if (confirmError) {
              console.warn(`confirm_talent_from_sighting failed for "${item.name}":`, confirmError.message);
            }
          }
        }

        // ── Talent ──────────────────────────────────────────────────────────
        for (const t of item.talent) {
          if (!t.name) continue;

          const talentId = await upsertTalent(t.name, supabase);
          if (!talentId) continue;

          const { error: linkError } = await supabase.from("event_talent").upsert(
            {
              event_id: eventId,
              talent_id: talentId,
              role: t.role ?? null,
              billing_position: t.billing_position ?? null,
            },
            { onConflict: "event_id,talent_id" },
          );

          if (linkError) {
            console.warn(`event_talent link failed for "${t.name}" on "${item.name}":`, linkError.message);
          }
        }

      } catch (itemErr: any) {
        console.error(`Unhandled error processing item "${item.name ?? "(unnamed)"}":`, itemErr);
      }
    }

    // ── Talent dedup ────────────────────────────────────────────────────────
    // Run after all items are written so the pass sees the full extraction.
    // v2 (see migration_run_talent_dedup_pass_v2.sql): p_dry_run used to
    // apply to both tiers uniformly, which meant an earlier { dry_run:
    // false } call here was silently running the name_similarity tier
    // live too -- that tier has zero corroborating signal beyond a 0.85
    // string-similarity bar and was always meant to require human review.
    //
    // Both tiers set to false for now, pending manual review of the full
    // same_event dry-run queue: a concatenation-noise false positive was
    // found in that tier ("Shelter Winston Hightowers" vs "Winston
    // Hightower" -- one extraction pass glued two adjacent lineup entries
    // together; co-occurrence corroborates relatedness, not that two
    // strings name the same act) and guarded against specifically, but
    // given co-occurrence alone has now produced two distinct false-
    // positive patterns this session, same_event shouldn't run live again
    // until `select * from run_talent_dedup_pass() where match_type =
    // 'same_event'` has been read through in full, not just spot-checked.
    const { error: dedupError } = await supabase.rpc("run_talent_dedup_pass", {
      p_run_same_event: true,
      p_run_name_similarity: false,
    });
    if (dedupError) {
      console.warn("run_talent_dedup_pass failed:", dedupError.message);
    }

    // Field reconciliation + auto-split.
    // Confidence-weighted plurality vote on name/date_start/location_name
    // across sightings. Talent/date/location corroboration (see
    // migration_run_field_reconciliation_pass_v5.sql) gates a safe
    // automatic split when clustering finds 2+ well-supported, genuinely
    // unrelated name groups -- those three signals exist specifically
    // because earlier versions of this pass, run against real data, either
    // missed a false merge (top-2-bucket comparison alone) or nearly split
    // a real event in half (name-clustering without a same-event
    // corroboration check). Anything the gates can't confidently resolve
    // files a pending 'possible_false_merge' report in event_reports for
    // human review instead of guessing.
    const { error: reconcileError } = await supabase.rpc("run_field_reconciliation_pass", {
      p_dry_run: false,
    });
    if (reconcileError) {
      console.warn("run_field_reconciliation_pass failed:", reconcileError.message);
    }

    // ── Mark complete ───────────────────────────────────────────────────────
    await supabase
      .from("photos")
      .update({
        extraction_status: "complete",
        extracted_at: new Date().toISOString(),
      })
      .eq("id", photoId);

    console.log(`Extraction complete for photo ${photoId}`);

  } catch (err: any) {
    console.error(`runExtraction failed for photo ${photoId}:`, err);
    await supabase
      .from("photos")
      .update({
        extraction_status: "failed",
        extraction_error: err?.message ?? String(err),
      })
      .eq("id", photoId);
  }
}

// ── Dispatch ───────────────────────────────────────────────────────────────
//
// Runs one already-claimed photo's extraction, then advances the queue.
// Always called wrapped in EdgeRuntime.waitUntil() by its caller (the
// internal request branch below) — never awaited by anything that's
// waiting to send an HTTP response, so it's free to take the full ~75s+
// without holding a connection open anywhere upstream.
//
// The claimAndDispatch() call at the end — not a separate cron tick — is
// what keeps the queue draining continuously: as soon as this photo's
// status is written, it immediately tries to claim whatever slot that
// just freed up. extract-drain only needs to catch what this misses.

async function dispatchExtraction(photoId: string, supabase: SupabaseClient): Promise<void> {
  const { data: photo, error: fetchError } = await supabase
    .from("photos")
    .select("image_url, board_id, captured_at")
    .eq("id", photoId)
    .single();

  if (fetchError || !photo) {
    console.error(`dispatchExtraction: could not load photo ${photoId}:`, fetchError?.message);
    await supabase
      .from("photos")
      .update({ extraction_status: "failed", extraction_error: "Photo record not found at dispatch time" })
      .eq("id", photoId);
    return;
  }

  await runExtraction(
    photoId,
    photo.image_url,
    photo.captured_at ?? new Date().toISOString(),
    photo.board_id,
    supabase,
  );

  await claimAndDispatch({
    supabase,
    extractUrl: EXTRACT_FUNCTION_URL,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
  }).catch(err => console.error("claimAndDispatch after extraction failed:", err));
}

// ── Request handler ────────────────────────────────────────────────────────
//
// Two distinct paths, branched on request body shape:
//
//   { photo_id }   — internal dispatch call, from claimAndDispatch (fired
//                    either by the browser path below right after it creates
//                    a row, or by the extract-drain cron backstop). Requires
//                    the service-role key as bearer, not a user JWT. Fires
//                    dispatchExtraction via waitUntil and returns immediately
//                    — the caller only needs the request to have landed, not
//                    for extraction to have finished.
//
//   { photo_path } — the original browser-facing path. Fast path only: auth
//                    + rate limit + board resolution + photo record. Returns
//                    {photo_id, board_id} in ~1s. Instead of unconditionally
//                    firing this photo's own extraction, it calls
//                    claimAndDispatch() — which may end up dispatching this
//                    photo, an older one still waiting its turn, several, or
//                    none, depending on how many slots extract_max_concurrent
//                    currently has free.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return respond({ error: "Method not allowed" }, 405);
  }

  let body: RequestBody;
  try {
    body = await req.json() as RequestBody;
  } catch {
    return respond({ error: "Invalid JSON body" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Internal dispatch path ────────────────────────────────────────────────
  if (body.photo_id) {
    const authHeader = req.headers.get("Authorization");
    if (authHeader !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) {
      return respond({ error: "Unauthorized" }, 401);
    }

    EdgeRuntime.waitUntil(dispatchExtraction(body.photo_id, supabase));
    return respond({ success: true });
  }

  const warnings: string[] = [];

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return respond({ error: "Unauthorized" }, 401);

  const token = authHeader.replace("Bearer ", "");
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token);
  if (authError || !user) return respond({ error: "Unauthorized" }, 401);

  // ── Parse request ─────────────────────────────────────────────────────────
  const { photo_path, lat, lng, capture_date, board_id } = body;
  if (!photo_path) {
    return respond({ error: "photo_path required" }, 400);
  }

  // Timestamp representing when the photo was actually taken.
  // Used for all observation timestamps (last_seen_at, last_sighted_at,
  // sighted_at) so the DB reflects reality rather than processing time.
  // Falls back to now() only when EXIF capture date wasn't available.
  // Persisted on the photo row (captured_at) rather than kept only as a
  // local variable — dispatchExtraction needs to read it back later, since
  // whichever invocation ends up running extraction for this photo may not
  // be this one.
  const capturedAt = capture_date
    ? new Date(capture_date).toISOString()
    : new Date().toISOString();

  if (!board_id && (!lat || !lng)) {
    warnings.push("No GPS coordinates or board_id provided — photo will not be linked to a board");
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────
  const today = new Date().toISOString().split("T")[0];
  const { count, error: countError } = await supabase
    .from("photos")
    .select("*", { count: "exact", head: true })
    .eq("submitted_by", user.id)
    .gte("created_at", `${today}T00:00:00Z`);

  if (countError) {
    warnings.push(`Rate limit check failed: ${countError.message}`);
    console.error("Rate limit query error:", JSON.stringify(countError));
  }

  const { data: limitConfig, error: configError } = await supabase
    .from("config")
    .select("value")
    .eq("key", "max_daily_submissions_per_user")
    .single();

  if (configError) {
    warnings.push("Could not read rate limit config — using default of 20");
    console.error("Config fetch error:", JSON.stringify(configError));
  }

  const maxSubmissions = parseInt(limitConfig?.value ?? "20");
  if (!countError && (count ?? 0) >= maxSubmissions) {
    return respond({ error: "Daily submission limit reached" }, 429);
  }

  // ── Resolve board ─────────────────────────────────────────────────────────
  let resolvedBoardId: string | null = board_id ?? null;

  if (!resolvedBoardId && lat && lng) {
    const { data: nearby, error: rpcError } = await supabase.rpc("find_nearby_board", {
      p_lat: lat,
      p_lng: lng,
      p_radius_meters: 20,
    });

    if (rpcError) {
      warnings.push(`Board lookup failed: ${rpcError.message}`);
      console.error("find_nearby_board error:", JSON.stringify(rpcError));
    } else if (nearby && nearby.length > 0) {
      resolvedBoardId = nearby[0].id;
      console.log("Found existing board:", resolvedBoardId);
    } else {
      const geo = await reverseGeocodeBoard(lat, lng);

      const { data: newBoard, error: boardError } = await supabase
        .from("boards")
        .insert({
          geolocation: `SRID=4326;POINT(${lng} ${lat})`,
          description:  geo?.description  ?? null,
          geo_city:     geo?.geo_city     ?? null,
          geo_region:   geo?.geo_region   ?? null,
          geo_country:  geo?.geo_country  ?? null,
          geo_neighborhood: geo?.geo_neighborhood ?? null,
        })
        .select("id")
        .single();

      if (boardError) {
        warnings.push(`Board creation failed: ${boardError.message}`);
        console.error("Board insert error:", JSON.stringify(boardError));
      } else {
        resolvedBoardId = newBoard?.id ?? null;
        console.log("Created new board:", resolvedBoardId, "—", geo?.description ?? "no description");
      }
    }
  }

  console.log("Board resolved:", resolvedBoardId ?? "none", "| lat:", lat, "| lng:", lng);

  // ── Create photo record ───────────────────────────────────────────────────
  const deleteAfter = new Date();
  deleteAfter.setDate(deleteAfter.getDate() + 90);

  const { data: photoRecord, error: photoError } = await supabase
    .from("photos")
    .insert({
      board_id: resolvedBoardId,
      submitted_by: user.id,
      image_url: photo_path,
      captured_at: capturedAt,
      delete_after: deleteAfter.toISOString(),
      extraction_status: "pending",  // updated to 'processing' by claim_pending_photos, then 'complete'/'failed' by runExtraction
    })
    .select("id")
    .single();

  if (photoError || !photoRecord) {
    console.error("Photo insert error:", JSON.stringify(photoError));
    return respond({ error: "Failed to create photo record", detail: photoError?.message, warnings }, 500);
  }

  // ── Update board timestamps ───────────────────────────────────────────────
  if (resolvedBoardId) {
    const { error: boardUpdateError } = await supabase
      .from("boards")
      .update({
        last_sighted_at: capturedAt,
        current_state_photo_id: photoRecord.id,
      })
      .eq("id", resolvedBoardId);

    if (boardUpdateError) {
      warnings.push(`Board timestamp update failed: ${boardUpdateError.message}`);
      console.error("Board update error:", JSON.stringify(boardUpdateError));
    }
  }

  // ── Hand off to the queue ─────────────────────────────────────────────────
  // Browser gets photo_id immediately. claimAndDispatch() decides what
  // actually starts running now — this photo, an older one still waiting,
  // several, or none — based on how much of extract_max_concurrent is free.
  // Not a guarantee this specific photo starts immediately: under real
  // backlog it may sit 'pending' until a slot frees (another extraction
  // finishing, or the extract-drain cron backstop).
  EdgeRuntime.waitUntil(
    claimAndDispatch({
      supabase,
      extractUrl: EXTRACT_FUNCTION_URL,
      serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
    })
  );

  const response: any = {
    success: true,
    photo_id: photoRecord.id,
    board_id: resolvedBoardId,
  };

  if (warnings.length > 0) response.warnings = warnings;

  return respond(response);
});