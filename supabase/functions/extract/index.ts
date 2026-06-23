import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SYSTEM_PROMPT } from "./system-prompt.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_EXTRACT_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
    try {
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
          // enrichment_attempted_at is NOT reset here unconditionally.
          // maybe_reenqueue_enrichment() below decides whether to re-queue
          // based on verification status and whether new search signal arrived.
        })
        .eq("id", eventId);

      if (updateError) {
        warnings.push(`Event merge failed for "${item.name}" (id: ${eventId}): ${updateError.message}`);
        console.error("Event update error:", JSON.stringify(updateError));
      }

      // Re-queue enrichment only if it would produce a different result:
      //   - no verifications yet (previous run found nothing or was rejected)
      //   AND
      //   - this sighting brings a new event_url (stronger search anchor)
      // If the event already has verifications, a correct local source was
      // found — don't pay to re-search.
      const { error: reenqueueError } = await supabase.rpc(
        "maybe_reenqueue_enrichment",
        {
          p_event_id:      eventId,
          p_new_event_url: item.event_url ?? null,
        }
      );

      if (reenqueueError) {
        warnings.push(`maybe_reenqueue_enrichment failed for "${item.name}": ${reenqueueError.message}`);
        console.error("maybe_reenqueue_enrichment error:", JSON.stringify(reenqueueError));
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
    } catch (err: any) {
      console.error(`Unhandled error processing item "${item.name ?? '(unnamed)'}":`, err);
      skipped.push({ name: item.name ?? '(unnamed)', reason: `Unhandled error: ${err?.message ?? err}` });
    }
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