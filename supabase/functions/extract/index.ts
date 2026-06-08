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
  Audience: "queer", "lgbtq", "family", "kids", "seniors", "womens"
  Format:   "benefit", "potluck", "outdoor", "all-ages", "diy"
  Topic:    "climate", "housing", "labor", "racial-justice", "food"
Return [] if no tags are determinable. Never return null.

FLYER STYLE
  "minimal"  — Intentionally sparse: xeroxed aesthetic, rough fonts,
               very limited info by design. Common for underground shows,
               DIY events, cash-at-door. Null fields are deliberate —
               not a reading failure.
  "standard" — Typical community flyer. Digitally designed, intends to
               convey full info, some fields may be missing.
  "detailed" — Professionally produced. Full info expected and present.

TALENT
Extract every named performer, speaker, artist, or presenter.
billing_position: infer from visual hierarchy — largest font or top of
list = 1, next = 2, etc. Use null if not determinable.
role: use vocabulary that fits the event type —
  music:    "headliner", "support", "opener", "performer", "dj"
  talk:     "keynote", "speaker", "panelist", "moderator"
  film:     "director", "screenwriter", "q&a_guest"
  workshop: "facilitator", "instructor"
  art:      "exhibiting_artist"
Use null if the flyer lists a name without describing their role.

DATE TYPES
  "specific"    — exact date; populate date_start (and date_end if range)
  "recurring"   — repeating; populate recurrence_rule and date_raw
  "approximate" — rough timeframe only; populate date_raw only
  "unknown"     — no date information present

RECURRENCE RULES (RRULE format)
  Every Wednesday    → FREQ=WEEKLY;BYDAY=WE
  Every 3rd Saturday → FREQ=MONTHLY;BYDAY=3SA

CONFIDENCE
Float 0.0–1.0. Measures reading quality, not information completeness.
A minimal flyer read perfectly scores high even with many null fields.
  0.90–1.00 — clean text, all readable fields extracted cleanly
  0.70–0.89 — mostly clear, minor uncertainty on a field or two
  0.40–0.69 — partial occlusion, stylized fonts, or low contrast
  0.00–0.39 — heavily obscured, handwritten, or largely unreadable
Include confidence_note whenever confidence is below 0.80.

CONTACT
Public-facing only: venue websites, booking pages, org websites,
public phone lines. Never include personal mobile numbers or personal
email addresses — leave contact null and note "personal contact withheld"
in confidence_note.

PRICE
Extract verbatim. Never normalize.
  price_raw: full text as printed — "$10 adv / $15 door", "free",
             "sliding scale $5–15", "PWYW". Null if not on the flyer.
  is_free: true if clearly free, false if any price stated, null if unclear.

OUTPUT FORMAT — return a JSON array of objects with these fields:
{
  "name": "title",
  "content_type": "event | announcement | resource | seeking | advocacy",
  "event_category": "music | film | theater | ... | null",
  "tags": [],
  "flyer_style": "minimal | standard | detailed",
  "organization": "name or null",
  "talent": [{"name": "...", "role": "... or null", "billing_position": 1}],
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
  "accessibility": [],
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

// Always returns a properly-formed Response with CORS headers.
// status must be a plain number — never pass an object here.
function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return respond({ error: "Method not allowed" }, 405);
  }

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
  const { photo_path, lat, lng, capture_date, board_id } = await req.json();
  if (!photo_path) {
    return respond({ error: "photo_path required" }, 400);
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────
  const today = new Date().toISOString().split("T")[0];
  const { count } = await supabase
    .from("photos")
    .select("*", { count: "exact", head: true })
    .eq("submitted_by", user.id)
    .gte("submitted_at", `${today}T00:00:00Z`);

  const { data: limitConfig } = await supabase
    .from("config")
    .select("value")
    .eq("key", "max_daily_submissions_per_user")
    .single();

  const maxSubmissions = parseInt(limitConfig?.value ?? "20");
  if ((count ?? 0) >= maxSubmissions) {
    return respond({ error: "Daily submission limit reached" }, 429);
  }

  // ── Download photo ────────────────────────────────────────────────────────
  const { data: photoBlob, error: downloadError } = await supabase.storage
    .from("photos-raw")
    .download(photo_path);

  if (downloadError || !photoBlob) {
    return respond({ error: "Photo not found" }, 404);
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
  let resolvedBoardId = board_id ?? null;

  if (!resolvedBoardId && lat && lng) {
    const { data: nearby } = await supabase.rpc("find_nearby_board", {
      p_lat: lat,
      p_lng: lng,
      p_radius_meters: 20,
    });

    if (nearby?.id) {
      resolvedBoardId = nearby.id;
    } else {
      const { data: newBoard } = await supabase
        .from("boards")
        .insert({ geolocation: `POINT(${lng} ${lat})` })
        .select("id")
        .single();
      resolvedBoardId = newBoard?.id ?? null;
    }
  }

  // ── Board context ─────────────────────────────────────────────────────────
  let boardDescription: string | null = null;
  let knownEvents: { name: string; date_start: string | null }[] | null = null;

  if (resolvedBoardId) {
    const { data: board } = await supabase
      .from("boards")
      .select("description")
      .eq("id", resolvedBoardId)
      .single();
    boardDescription = board?.description ?? null;

    const { data: flyers } = await supabase
      .from("board_flyers")
      .select("events(name, date_start)")
      .eq("board_id", resolvedBoardId)
      .eq("is_active", true)
      .order("last_seen_at", { ascending: false })
      .limit(10);

    if (flyers?.length) {
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
    return respond({ error: "Claude API error", detail: err }, 502);
  }

  const claudeData = await claudeRes.json();
  const rawText = claudeData.content?.[0]?.text ?? "";

  let extractedItems: any[];
  try {
    extractedItems = JSON.parse(rawText);
    if (!Array.isArray(extractedItems)) throw new Error("Expected array");
  } catch {
    console.error("Parse failed. Raw text:", rawText.slice(0, 500));
    return respond({ error: "Failed to parse extraction response" }, 500);
  }

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
      extracted_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (photoError)
    console.error("Photo insert error:", JSON.stringify(photoError));

  if (resolvedBoardId) {
    await supabase
      .from("boards")
      .update({
        last_sighted_at: new Date().toISOString(),
        current_state_photo_id: photoRecord?.id,
      })
      .eq("id", resolvedBoardId);
  }

  // ── Write extracted items to DB ───────────────────────────────────────────
  const results: { event_id: string; name: string }[] = [];
  const seenEventIds = new Set<string>();

  for (const item of extractedItems) {
    let eventId: string | null = null;

    // Simple dedup: URL hard match
    if (item.event_url) {
      const { data: existing } = await supabase
        .from("events")
        .select("id")
        .eq("event_url", item.event_url)
        .eq("is_active", true)
        .maybeSingle();
      if (existing) eventId = existing.id;
    }

    // Organization lookup / create
    let organizationId: string | null = null;
    if (item.organization) {
      const canonical = item.organization.toLowerCase().trim();
      const { data: existingOrg } = await supabase
        .from("organizations")
        .select("id")
        .eq("canonical_name", canonical)
        .maybeSingle();

      if (existingOrg) {
        organizationId = existingOrg.id;
        await supabase
          .from("organizations")
          .update({ last_active_at: new Date().toISOString() })
          .eq("id", organizationId);
      } else {
        const { data: newOrg } = await supabase
          .from("organizations")
          .insert({
            name: item.organization,
            canonical_name: canonical,
            last_active_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        organizationId = newOrg?.id ?? null;
      }
    }

    // Create or update event
    if (!eventId) {
      const { data: newEvent, error: insertEventError } = await supabase
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
        })
        .select("id")
        .single();

      if (insertEventError)
        console.error("Event insert error:", JSON.stringify(insertEventError));
      eventId = newEvent?.id ?? null;
    } else {
      // Merge: scalar last-write-wins (non-null only), arrays union
      const { data: existing } = await supabase
        .from("events")
        .select("tags, accessibility")
        .eq("id", eventId)
        .single();

      await supabase
        .from("events")
        .update({
          last_sighted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          tags: [...new Set([...(existing?.tags ?? []), ...(item.tags ?? [])])],
          accessibility: [
            ...new Set([
              ...(existing?.accessibility ?? []),
              ...(item.accessibility ?? []),
            ]),
          ],
          ...(item.event_category && { event_category: item.event_category }),
          ...(item.age_restriction && {
            age_restriction: item.age_restriction,
          }),
          ...(item.language && { language: item.language }),
          ...(item.is_outdoor != null && { is_outdoor: item.is_outdoor }),
          ...(item.masks_required && { masks_required: item.masks_required }),
          ...(item.price_raw && { price_raw: item.price_raw }),
          ...(item.event_url && { event_url: item.event_url }),
          ...(item.flyer_style && { flyer_style: item.flyer_style }),
        })
        .eq("id", eventId);
    }

    if (!eventId) continue;
    seenEventIds.add(eventId);

    // Sighting
    await supabase.from("event_sightings").insert({
      event_id: eventId,
      photo_id: photoRecord?.id ?? null,
      board_id: resolvedBoardId,
      raw_extraction: item,
      extraction_confidence: item.confidence ?? 0.5,
      flyer_style: item.flyer_style ?? null,
    });

    // Board flyer upsert
    if (resolvedBoardId) {
      await supabase.from("board_flyers").upsert(
        {
          board_id: resolvedBoardId,
          event_id: eventId,
          last_seen_at: new Date().toISOString(),
          is_active: true,
          removed_at: null,
        },
        { onConflict: "board_id,event_id" },
      );
    }

    // Talent
    for (const t of item.talent ?? []) {
      if (!t.name) continue;
      const canonical = t.name.toLowerCase().trim();

      const { data: existingTalent } = await supabase
        .from("talent")
        .select("id")
        .eq("canonical_name", canonical)
        .maybeSingle();

      let talentId: string | null = null;
      if (existingTalent) {
        talentId = existingTalent.id;
        await supabase
          .from("talent")
          .update({ last_active_at: new Date().toISOString() })
          .eq("id", talentId);
      } else {
        const { data: newTalent } = await supabase
          .from("talent")
          .insert({
            name: t.name,
            canonical_name: canonical,
            last_active_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        talentId = newTalent?.id ?? null;
      }

      if (talentId) {
        await supabase.from("event_talent").upsert(
          {
            event_id: eventId,
            talent_id: talentId,
            role: t.role ?? null,
            billing_position: t.billing_position ?? null,
          },
          { onConflict: "event_id,talent_id" },
        );
      }
    }

    results.push({ event_id: eventId, name: item.name });
  }

  // ── Mark removed flyers ───────────────────────────────────────────────────
  if (resolvedBoardId && seenEventIds.size > 0) {
    const { data: activeFlyers } = await supabase
      .from("board_flyers")
      .select("event_id")
      .eq("board_id", resolvedBoardId)
      .eq("is_active", true);

    const removedIds = (activeFlyers ?? [])
      .map((f: any) => f.event_id)
      .filter((id: string) => !seenEventIds.has(id));

    if (removedIds.length > 0) {
      await supabase
        .from("board_flyers")
        .update({ is_active: false, removed_at: new Date().toISOString() })
        .eq("board_id", resolvedBoardId)
        .in("event_id", removedIds);
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  return respond({
    success: true,
    photo_id: photoRecord?.id,
    board_id: resolvedBoardId,
    events_extracted: results.length,
    events: results,
  });
});
