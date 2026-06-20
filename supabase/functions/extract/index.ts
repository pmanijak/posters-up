import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;


const SYSTEM_PROMPT = `You are an event extraction system for a community bulletin board app.
Analyze photos of physical bulletin boards and extract structured data
about every item posted.

RULES
- Extract EVERY distinct item, not just traditional events.
- Never hallucinate. Use null for any field you cannot confidently read.
- Each distinct flyer is a separate item, even when flyers overlap.
- Infer fields from context when not explicitly stated — a photo of a
  band flyer is clearly "music" even without a label. Use judgment.
- Crossed-out or struck-through text is a retraction, not a value.
  Do not use it as the current field value. See CROSSED-OUT TEXT.
- Return ONLY a valid JSON array. No markdown, no explanation, no code fences.

CONTENT TYPES
  "event"        — something happening at a specific time and place
  "announcement" — general news, fundraiser, notice
  "resource"     — ongoing service (clinic, support group, hotline)
  "seeking"      — wanted post (rehearsal space, volunteers, roommates)
  "advocacy"     — political or cause-oriented flyer

EVENT CATEGORIES
Populate for content_type "event" whenever determinable. Infer from
visual content and context even without an explicit label.
  "music"         — concert, show, open mic, DJ night, battle of bands
  "film"          — screening, festival, documentary, short film night
  "theater"       — play, musical, improv, performance art, puppet show
  "dance"         — performance or social dancing (contra, swing, salsa...)
  "comedy"        — stand-up, sketch, improv comedy
  "spoken_word"   — poetry reading, storytelling, author reading
  "visual_art"    — gallery opening, art walk, studio tour, exhibition
  "market"        — farmers market, craft fair, flea market, pop-up shop
  "lecture"       — talk, presentation, panel, symposium, Q&A
  "workshop"      — participatory skill-building (craft, cooking, writing...)
  "fitness"       — yoga, run club, dance class, sport, outdoor activity
  "community"     — neighborhood meeting, town hall, civic gathering
  "support_group" — recurring peer support (AA, NA, grief, parenting...)
  "fundraiser"    — benefit show, auction, raffle, bake sale, charity run
  "party"         — social gathering, holiday celebration, release party
  "other"         — doesn't fit above
Leave null for non-event content types.

TAGS
Free-form labels for soft search matching. Extract from flyer content;
do not invent tags not supported by what you can read. Examples:
  Genre:    "punk", "jazz", "folk", "hip-hop", "classical", "electronic"
  Audience: "queer", "lgbtq", "family", "kids", "seniors", "womens",
            "latinx", "indigenous", "poc"
  Format:   "benefit", "potluck", "outdoor", "all-ages", "diy"
  Topic:    "climate", "housing", "labor", "racial-justice", "food"
  Vibe:     "acoustic", "intimate", "rowdy", "fancy"
Return [] (empty array) if no tags are determinable. Never return null.

FLYER STYLE
  "minimal"  — Intentionally sparse: xeroxed aesthetic, rough fonts,
               very limited info by design. Common for underground shows,
               DIY events, cash-at-door. Null fields are deliberate —
               not a reading failure. Distinguish from a standard flyer
               with missing fields due to occlusion or bad photography.
  "standard" — Typical community flyer. Digitally designed, intends to
               convey full info, some fields may be missing.
  "detailed" — Professionally produced. Full info expected and present.

TALENT
Extract every named performer, speaker, artist, or presenter.
billing_position: infer from visual hierarchy — largest font or top of
list = 1, next = 2, etc. Use null if position is not determinable.
role: use the vocabulary that fits the event type —
  music:    "headliner", "support", "opener", "performer", "dj"
  talk:     "keynote", "speaker", "panelist", "moderator"
  film:     "director", "screenwriter", "q&a_guest"
  workshop: "facilitator", "instructor"
  art:      "exhibiting_artist"
Use null if the flyer lists a name without describing their role.

DATE TYPES
  "specific"    — a defined start date is known; populate date_start and
                  date_end if the run spans multiple days. Use this even
                  when showtimes vary across the run — a known date range
                  is specific.
  "recurring"   — repeating pattern; populate recurrence_rule and date_raw
  "approximate" — genuinely vague timeframe only ("this summer", "coming
                  soon", "late July"); no defined start date determinable
  "unknown"     — no date information present

RECURRENCE RULES (RRULE format)
  Every Wednesday     → FREQ=WEEKLY;BYDAY=WE
  Every 3rd Saturday  → FREQ=MONTHLY;BYDAY=3SA
  Every 4th Tuesday   → FREQ=MONTHLY;BYDAY=4TU

DATES
Use the photo capture date from the user message to resolve relative
dates ("this Saturday") into specific calendar dates where possible.
If unresolvable, use date_type "approximate" and preserve the original
text in date_raw.

For multi-performance runs (a show running Thursday–Sunday, a film
screening several nights), use date_start/date_end for the full span
and date_type "specific". If showtimes vary by day, put the complete
schedule in description verbatim from the flyer. Use time_start for
the primary or most common showtime if one is clearly dominant;
otherwise leave time_start null.

PRICE
Extract verbatim from the flyer. Never normalize or reformat.
  price_raw: the full text as printed — "$10 adv / $15 door",
             "free", "sliding scale $5–15", "suggested donation",
             "PWYW", "free with RSVP". Null if not on the flyer.
  is_free: true if price_raw is null or clearly free (e.g. "free",
           "no cover", "free admission"). false if any price is stated.
           null if unclear (e.g. "donation" without "suggested" could
           be either).

CROSSED-OUT TEXT
Physical flyers are often corrected in place — a price slashed and rewritten,
a date crossed out and replaced, a venue name struck through. Crossed-out text
is a retraction; do not use it as the current field value.

Convention for all affected fields — use this format in the field itself:
  "[crossed out: X] Y"  — X was struck, replaced by Y
  "[crossed out: X]"    — X was struck, replacement not legible or absent

price_raw examples:
  "$150" struck, "free" written next to it →
    price_raw: "[crossed out: $150] free", is_free: true
  "$20" struck, nothing else visible →
    price_raw: "[crossed out: $20]", is_free: null

For non-price fields (date_raw, location_name, time_start, etc.):
  If the replacement is clearly legible, populate the field with the replacement
  value and note the correction in confidence_note:
    "date crossed out; replacement used"
  If the replacement is ambiguous or absent, use null and note in confidence_note.

Handwritten replacements next to struck text compound the uncertainty — the
retraction is deliberate, but the new value may be partially illegible. Reduce
confidence_score accordingly and always include a confidence_note when any
field contains crossed-out or corrected content.

AGE RESTRICTION
Populate from explicit flyer text or common venue conventions.
  "all_ages" — explicitly stated; all ages welcome
  "family"   — kids expected and welcome (story time, family show, etc.)
  "18+"      — stated or implied by event type + venue
  "21+"      — stated, or bar/brewery venue with no age override
  null       — not determinable from the flyer

AUDIENCE AND ACCESS
  is_public: true for standard community events on public boards.
             false for members-only, private, or invite-only events.
             null if genuinely ambiguous.
  language:  BCP 47 code for the primary event language. Set when the
             flyer is in another language OR explicitly states the event
             language ("Reunión en español" → "es"). Null otherwise
             (English assumed for US boards).

ENVIRONMENT
  is_outdoor: true if event is outdoors (park, waterfront, parking lot,
              street fair). false if clearly indoors. null if not
              determinable. Infer from venue name when possible
              (e.g. "Sylvester Park" → true).

ACCESSIBILITY
Look for the international wheelchair symbol (♿), and phrases like:
"wheelchair accessible", "ADA accessible", "elevator access",
"ASL interpretation", "ASL provided", "no one turned away for lack of
funds", "NOTAFLOF", "sliding scale", "sober event", "dry event",
"fragrance free", "masks required/encouraged/optional".
Common accessibility array values:
  "wheelchair", "elevator", "asl", "gender_neutral_restroom",
  "no_one_turned_away", "sliding_scale", "sober", "fragrance_free"
Return [] if none found. Do not infer accessibility not shown on flyer.
Exception: if venue_name is clearly a library or civic building and
flyer is detailed-style, wheelchair access is a reasonable inference.

MASKS
  masks_required: extract if stated. Values:
    "required"      — "masks required", "please wear a mask"
    "recommended"   — "masks encouraged", "masks recommended"
    "optional"      — "masks optional", "mask friendly"
    "not_required"  — "no mask required", explicitly stated
    null            — not mentioned on the flyer

REGISTRATION AND LINKS
  event_url: the specific URL or QR code destination for this event —
             an Eventbrite listing, Facebook event, venue calendar page,
             or dedicated website. Distinct from contact (organizer's
             general presence). If a QR code is visible but unreadable,
             set to null and note "QR code present, unreadable" in
             confidence_note.
  rsvp_required: true if RSVP or registration is explicitly required.
                 false if walk-ins are explicitly welcomed. null if
                 not stated.
  rsvp_url: URL or email address for RSVP if distinct from event_url.

CONTACT
Public-facing only: venue websites, booking pages, org websites,
public phone lines. Never include personal mobile numbers or personal
email addresses — leave contact null and note "personal contact
withheld" in confidence_note. confidence_note serves double duty here;
the pipeline checks it for both reading quality and contact policy.

CONFIDENCE
Float 0.0–1.0. Measures reading quality, not information completeness.
A minimal flyer read perfectly scores high even with many null fields.
  0.90–1.00 — clean text, all readable fields extracted cleanly
  0.70–0.89 — mostly clear, minor uncertainty on a field or two
  0.40–0.69 — partial occlusion, stylized fonts, or low contrast
  0.00–0.39 — heavily obscured, handwritten, or largely unreadable

Include confidence_note whenever confidence is below 0.80.
For minimal flyers, note if null fields appear intentional rather than
unreadable (e.g. "no address — likely withheld by design").

OUTPUT FORMAT
{
  "name": "title",
  "content_type": "event | announcement | resource | seeking | advocacy",
  "event_category": "music | film | theater | ... | null",
  "tags": ["tag1", "tag2"],
  "flyer_style": "minimal | standard | detailed",
  "organization": "name or null",
  "talent": [
    {
      "name": "act or person name",
      "role": "headliner | speaker | director | ... | null",
      "billing_position": 1
    }
  ],
  "date_type": "specific | recurring | approximate | unknown",
  "date_start": "YYYY-MM-DD or null",
  "date_end": "YYYY-MM-DD or null",
  "time_start": "HH:MM or null",
  "time_end": "HH:MM or null",
  "recurrence_rule": "RRULE string or null",
  "date_raw": "date text as it appears, or null",
  "location_name": "venue name or null",
  "location_address": "street address or null",
  "is_outdoor": true | false | null,
  "description": "1-2 sentences or null",
  "contact": "public-facing contact or null",
  "event_url": "URL or null",
  "price_raw": "admission text or null",
  "is_free": true | false | null,
  "age_restriction": "all_ages | family | 18+ | 21+ | null",
  "is_public": true | false | null,
  "language": "BCP 47 or null",
  "accessibility": ["wheelchair", "asl", ...],
  "masks_required": "required | recommended | optional | not_required | null",
  "rsvp_required": true | false | null,
  "rsvp_url": "URL or null",
  "confidence": 0.0,
  "confidence_note": "explanation if confidence below 0.80, else null"
}`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Reverse geocodes a board location at street level (zoom=17).
// Populates both the human-readable description ("4th Ave E, Olympia")
// and the city/region/country cache used by the enrich function.
// Non-blocking — if Nominatim fails, board is created without description.
async function reverseGeocodeBoard(lat: number, lng: number): Promise<{
  description: string | null
  geo_city: string | null
  geo_region: string | null
  geo_country: string | null
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
    const description = [road, city].filter(Boolean).join(", ") || null
    return { description, geo_city: city, geo_region: region, geo_country: country }
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return respond({ error: "Method not allowed" }, 405);
  }

  const warnings: string[] = [];

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return respond({ error: "Unauthorized" }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const token = authHeader.replace("Bearer ", "");
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token);
  if (authError || !user) return respond({ error: "Unauthorized" }, 401);

  // ── Parse request ─────────────────────────────────────────────────────────
  let body: any;
  try {
    body = await req.json();
  } catch {
    return respond({ error: "Invalid JSON body" }, 400);
  }

  const { photo_path, lat, lng, capture_date, board_id } = body;
  if (!photo_path) {
    return respond({ error: "photo_path required" }, 400);
  }

  // Timestamp representing when the photo was actually taken.
  // Used for all observation timestamps (last_seen_at, last_sighted_at,
  // sighted_at) so the DB reflects reality rather than processing time.
  // Falls back to now() only when EXIF capture date wasn't available.
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

  // ── Download photo ────────────────────────────────────────────────────────
  const { data: photoBlob, error: downloadError } = await supabase.storage
    .from("photos-raw")
    .download(photo_path);

  if (downloadError || !photoBlob) {
    console.error("Photo download error:", JSON.stringify(downloadError));
    return respond({ error: "Photo not found", detail: downloadError?.message }, 404);
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
      const geo = await reverseGeocodeBoard(lat, lng)

      const { data: newBoard, error: boardError } = await supabase
        .from("boards")
        .insert({
          geolocation: `SRID=4326;POINT(${lng} ${lat})`,
          description:  geo?.description  ?? null,
          geo_city:     geo?.geo_city     ?? null,
          geo_region:   geo?.geo_region   ?? null,
          geo_country:  geo?.geo_country  ?? null,
        })
        .select("id")
        .single()

      if (boardError) {
        warnings.push(`Board creation failed: ${boardError.message}`)
        console.error("Board insert error:", JSON.stringify(boardError))
      } else {
        resolvedBoardId = newBoard?.id ?? null
        console.log("Created new board:", resolvedBoardId, "—", geo?.description ?? "no description")
      }
    }
  }

  console.log("Board resolved:", resolvedBoardId ?? "none", "| lat:", lat, "| lng:", lng);

  // ── Board context ─────────────────────────────────────────────────────────
  let boardDescription: string | null = null;
  let knownEvents: { name: string; date_start: string | null }[] | null = null;

  if (resolvedBoardId) {
    const { data: board, error: boardFetchError } = await supabase
      .from("boards")
      .select("description")
      .eq("id", resolvedBoardId)
      .single();

    if (boardFetchError) {
      warnings.push(`Could not fetch board context: ${boardFetchError.message}`);
      console.error("Board context fetch error:", JSON.stringify(boardFetchError));
    } else {
      boardDescription = board?.description ?? null;
    }

    const { data: flyers, error: flyersError } = await supabase
      .from("board_flyers")
      .select("events(name, date_start)")
      .eq("board_id", resolvedBoardId)
      .eq("is_active", true)
      .order("last_seen_at", { ascending: false })
      .limit(10);

    if (flyersError) {
      warnings.push(`Could not fetch known board events: ${flyersError.message}`);
      console.error("Board flyers fetch error:", JSON.stringify(flyersError));
    } else if (flyers?.length) {
      knownEvents = flyers
        .map((f: any) => ({
          name: f.events?.name,
          date_start: f.events?.date_start,
        }))
        .filter((e: any) => e.name);
    }
  }

  // ── Call Claude ───────────────────────────────────────────────────────────
  const userMessage = [
    `Photo taken: ${capture_date ?? new Date().toISOString().split("T")[0]}`,
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
      system: SYSTEM_PROMPT,
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
    console.error("Claude API error:", claudeRes.status, err);
    return respond({ error: "Claude API error", detail: err, warnings }, 502);
  }

  const claudeData = await claudeRes.json();
  const rawText = claudeData.content?.[0]?.text ?? "";

  let extractedItems: any[];
  try {
    extractedItems = JSON.parse(rawText);
    if (!Array.isArray(extractedItems)) throw new Error("Response was not a JSON array");
  } catch (parseErr: any) {
    console.error("Claude response parse failed. Raw text:", rawText.slice(0, 500));
    return respond({
      error: "Failed to parse extraction response",
      detail: parseErr.message,
      raw_preview: rawText.slice(0, 200),
      warnings,
    }, 500);
  }

  console.log(`Claude extracted ${extractedItems.length} items`);

  // ── Create photo record ───────────────────────────────────────────────────
  const deleteAfter = new Date();
  deleteAfter.setDate(deleteAfter.getDate() + 90);

  const { data: photoRecord, error: photoError } = await supabase
    .from("photos")
    .insert({
      board_id: resolvedBoardId,
      submitted_by: user.id,
      image_url: photo_path,
      delete_after: deleteAfter.toISOString(),
      extraction_status: "complete",
      extracted_at: new Date().toISOString(),  // processing time, not capture time
    })
    .select("id")
    .single();

  if (photoError) {
    warnings.push(`Photo record creation failed: ${photoError.message}`);
    console.error("Photo insert error:", JSON.stringify(photoError));
  }

  if (resolvedBoardId) {
    const { error: boardUpdateError } = await supabase
      .from("boards")
      .update({
        last_sighted_at: capturedAt,
        current_state_photo_id: photoRecord?.id,
      })
      .eq("id", resolvedBoardId);

    if (boardUpdateError) {
      warnings.push(`Board timestamp update failed: ${boardUpdateError.message}`);
      console.error("Board update error:", JSON.stringify(boardUpdateError));
    }
  }

  // ── Write extracted items to DB ───────────────────────────────────────────
  const results: { event_id: string; name: string; match_type?: string }[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const item of extractedItems) {
    if (!item.name) {
      skipped.push({ name: "(unnamed)", reason: "Missing name field" });
      continue;
    }

    let eventId: string | null = null;
    let matchType: string = "none";

    // ── Event matching ────────────────────────────────────────────────────
    // Top-billed act: prefer explicit billing_position = 1, fall back to
    // the first talent entry. Passed to find_event_match() as the talent
    // anchor signal — a stable identity even when the AI names the event
    // differently across extractions of the same flyer.
    const topAct: string | null =
      item.talent?.find((t: any) => t.billing_position === 1)?.name
      ?? item.talent?.[0]?.name
      ?? null;

    const { data: match, error: matchError } = await supabase.rpc("find_event_match", {
      p_name:          item.name,
      p_date_start:    item.date_start ?? null,
      p_location_name: item.location_name ?? null,
      p_board_lat:     lat ?? null,
      p_board_lng:     lng ?? null,
      p_event_url:     item.event_url ?? null,
      p_talent_name:   topAct,
    });

    if (matchError) {
      warnings.push(`Event match check failed for "${item.name}": ${matchError.message}`);
      console.error("find_event_match error:", JSON.stringify(matchError));
    } else if (match?.match_id) {
      eventId = match.match_id;
      matchType = match.match_type;
    }

    // ── Organization lookup / create ──────────────────────────────────────
    let organizationId: string | null = null;
    if (item.organization) {
      const canonical = item.organization.toLowerCase().trim();
      const { data: existingOrg, error: orgLookupError } = await supabase
        .from("organizations")
        .select("id")
        .eq("canonical_name", canonical)
        .maybeSingle();

      if (orgLookupError) {
        warnings.push(`Org lookup failed for "${item.organization}": ${orgLookupError.message}`);
        console.error("Org lookup error:", JSON.stringify(orgLookupError));
      } else if (existingOrg) {
        organizationId = existingOrg.id;
        await supabase
          .from("organizations")
          .update({ last_active_at: new Date().toISOString() })
          .eq("id", organizationId);
      } else {
        const { data: newOrg, error: orgInsertError } = await supabase
          .from("organizations")
          .insert({
            name: item.organization,
            canonical_name: canonical,
            last_active_at: new Date().toISOString(),
          })
          .select("id")
          .single();

        if (orgInsertError) {
          warnings.push(`Org creation failed for "${item.organization}": ${orgInsertError.message}`);
          console.error("Org insert error:", JSON.stringify(orgInsertError));
        } else {
          organizationId = newOrg?.id ?? null;
        }
      }
    }

    // ── Create or update event ────────────────────────────────────────────
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
        skipped.push({ name: item.name, reason: `Event insert failed: ${eventInsertError.message}` });
        console.error(`Event insert error for "${item.name}":`, JSON.stringify(eventInsertError));
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
        warnings.push(`Could not fetch existing event data for merge (id: ${eventId}): ${fetchExistingError.message}`);
        console.error("Existing event fetch error:", JSON.stringify(fetchExistingError));
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
          // Reset enrichment queue so enrich re-runs with fresh sighting data
          enrichment_attempted_at: null,
        })
        .eq("id", eventId);

      if (updateError) {
        warnings.push(`Event merge failed for "${item.name}" (id: ${eventId}): ${updateError.message}`);
        console.error("Event update error:", JSON.stringify(updateError));
      }
    }

    if (!eventId) {
      skipped.push({ name: item.name, reason: "No event ID after insert" });
      continue;
    }

    // ── Sighting ──────────────────────────────────────────────────────────
    const { error: sightingError } = await supabase.from("event_sightings").insert({
      event_id: eventId,
      photo_id: photoRecord?.id ?? null,
      board_id: resolvedBoardId,
      raw_extraction: item,
      extraction_confidence: item.confidence ?? 0.5,
      flyer_style: item.flyer_style ?? null,
      sighted_at: capturedAt,
    });

    if (sightingError) {
      warnings.push(`Sighting insert failed for "${item.name}": ${sightingError.message}`);
      console.error("Sighting insert error:", JSON.stringify(sightingError));
    }

    // ── Board flyer upsert ────────────────────────────────────────────────
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
        warnings.push(`Board flyer upsert failed for "${item.name}": ${flyerError.message}`);
        console.error("Board flyer upsert error:", JSON.stringify(flyerError));
      }
    }

    // ── Talent ────────────────────────────────────────────────────────────
    for (const t of item.talent ?? []) {
      if (!t.name) continue;
      const canonical = t.name.toLowerCase().trim();

      const { data: existingTalent, error: talentLookupError } = await supabase
        .from("talent")
        .select("id")
        .eq("canonical_name", canonical)
        .maybeSingle();

      if (talentLookupError) {
        warnings.push(`Talent lookup failed for "${t.name}": ${talentLookupError.message}`);
        console.error("Talent lookup error:", JSON.stringify(talentLookupError));
        continue;
      }

      let talentId: string | null = null;
      if (existingTalent) {
        talentId = existingTalent.id;
        await supabase
          .from("talent")
          .update({ last_active_at: new Date().toISOString() })
          .eq("id", talentId);
      } else {
        const { data: newTalent, error: talentInsertError } = await supabase
          .from("talent")
          .insert({
            name: t.name,
            canonical_name: canonical,
            last_active_at: new Date().toISOString(),
          })
          .select("id")
          .single();

        if (talentInsertError) {
          warnings.push(`Talent creation failed for "${t.name}": ${talentInsertError.message}`);
          console.error("Talent insert error:", JSON.stringify(talentInsertError));
          continue;
        }

        talentId = newTalent?.id ?? null;
      }

      if (talentId) {
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
          warnings.push(`event_talent link failed for "${t.name}" on "${item.name}": ${linkError.message}`);
          console.error("event_talent upsert error:", JSON.stringify(linkError));
        }
      }
    }

    results.push({ event_id: eventId, name: item.name, match_type: matchType });
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  const response: any = {
    success: true,
    photo_id: photoRecord?.id ?? null,
    board_id: resolvedBoardId,
    events_extracted: results.length,
    events_skipped: skipped.length,
    events: results,
  };

  if (skipped.length > 0) response.skipped = skipped;
  if (warnings.length > 0) response.warnings = warnings;

  return respond(response);
});