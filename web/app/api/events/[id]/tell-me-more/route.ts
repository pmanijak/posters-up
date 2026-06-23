// app/api/events/[id]/tell-me-more/route.ts
//
// Returns board locations and enrichment data for the event card expansion.
//
// Two data sources:
//   event_board_locations view — boards currently showing this flyer
//   event_sightings.enrichment_data — web research produced by enrich function
//
// Contact display policy (enforced here, not just in the pipeline):
//   enrichment_data.found.contact must be a public-facing URL only.
//   This route sanitizes that field as a defense-in-depth measure —
//   the enrich prompt already excludes personal contacts, but the
//   route handler is the last line before the data reaches the client.
//
// Auth: uses SUPABASE_TELL_ME_MORE_KEY (service role scoped key).
// The key scope is not the real access control — the sanitization here is.

import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import type { EnrichmentData } from "@/lib/types/enrichment";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_TELL_ME_MORE_KEY!
);

// Patterns that indicate a personal contact rather than a public-facing URL.
// A phone number or personal email should never reach the client.
function isPersonalContact(value: string): boolean {
  // Personal email: contains @ but is not a URL
  if (value.includes("@") && !value.startsWith("http")) return true;
  // Phone number: digits, spaces, dashes, parens, plus — no protocol
  if (/^[\d\s\-()+.ext]+$/i.test(value.trim())) return true;
  return false;
}

function sanitizeEnrichment(data: EnrichmentData): EnrichmentData {
  if (!data.found?.contact) return data;
  if (isPersonalContact(data.found.contact)) {
    return {
      ...data,
      found: { ...data.found, contact: null },
    };
  }
  return data;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: eventId } = await params;

  // Basic UUID format check — avoids hitting the DB on obviously bad input.
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) {
    return NextResponse.json({ error: "Invalid event ID" }, { status: 400 });
  }

  // ── Board locations ───────────────────────────────────────────────────────
  const { data: boards, error: boardsError } = await supabase
    .from("event_board_locations")
    .select(
      "board_id, location_name, board_description, last_seen_at, lat, lng, " +
      "managed_by, requires_entry_to_photograph"
    )
    .eq("event_id", eventId)
    .order("last_seen_at", { ascending: false });

  if (boardsError) {
    console.error(`tell-me-more boards error for ${eventId}:`, boardsError);
  }

  // ── Enrichment data ───────────────────────────────────────────────────────
  // Take the most recent sighting that has enrichment data.
  // The enrich function writes the same enrichment_data to all unenriched
  // sightings for an event in a single pass, so any of them will do —
  // most recent is safest in case of a re-enrichment.
  const { data: sighting, error: sightingError } = await supabase
    .from("event_sightings")
    .select("enrichment_data")
    .eq("event_id", eventId)
    .not("enrichment_data", "is", null)
    .order("sighted_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (sightingError) {
    console.error(`tell-me-more enrichment error for ${eventId}:`, sightingError);
  }

  const rawEnrichment = sighting?.enrichment_data as EnrichmentData | null;

  // Discard old-format enrichment data that predates the new shape.
  // Old format stored everything inside found{} with no top-level description,
  // talent, or venue_context. The new card can't render it meaningfully and
  // would show an empty "Found online" section. Return null so the card
  // treats the event as unenriched until the enrich function re-processes it.
  const hasNewFormat = rawEnrichment && (
    rawEnrichment.description !== undefined ||
    Array.isArray(rawEnrichment.talent) ||
    rawEnrichment.venue_context !== undefined
  );

  const enrichment = hasNewFormat ? sanitizeEnrichment(rawEnrichment!) : null;

  return NextResponse.json({
    boards: boards ?? [],
    enrichment,
  });
}