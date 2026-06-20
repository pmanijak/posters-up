import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

const PHONE_RE = /\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g
const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g

function sanitizeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return v.startsWith('http://') || v.startsWith('https://') ? v : null
}

function sanitizeText(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const cleaned = value.replace(PHONE_RE, '').replace(EMAIL_RE, '').trim()
  return cleaned || null
}

const FIELD_LABELS: Record<string, string> = {
  name: 'name',
  date_start: 'date',
  date_end: 'end date',
  time_start: 'time',
  time_end: 'end time',
  location_name: 'venue',
  location_address: 'address',
  description: 'description',
  price_raw: 'price',
  event_url: 'link',
  contact: 'contact',
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: eventId } = await context.params

  if (!eventId || typeof eventId !== 'string') {
    return NextResponse.json({ error: 'Invalid event id' }, { status: 400 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_TELL_ME_MORE_KEY!
  )

  const [boardsRes, verifyRes, sightingRes] = await Promise.all([
    supabase
      .from('event_board_locations')
      .select('board_id, location_name, board_description, last_seen_at, lat, lng, managed_by, requires_entry_to_photograph')
      .eq('event_id', eventId)
      .order('last_seen_at', { ascending: false }),

    supabase
      .from('event_verifications')
      .select('source_url, source_type, verified_fields')
      .eq('event_id', eventId)
      .order('trust_weight', { ascending: false }),

    supabase
      .from('event_sightings')
      .select('enrichment_data')
      .eq('event_id', eventId)
      .not('enrichment_data', 'is', null)
      .order('sighted_at', { ascending: false })
      .limit(1)
      .single(),
  ])

  console.log(boardsRes.error);

  // Deduplicate verifications by source_url.
  // The enrich function may insert multiple rows for the same URL if it
  // ran more than once for this event (e.g. after a new sighting re-queued it).
  // Merge confirmed fields across duplicate rows so each source appears once.
  const verificationMap = new Map<string, { source_type: string; confirmed: Set<string> }>()
  for (const v of verifyRes.data ?? []) {
    const raw = v.verified_fields as Record<string, boolean> | null
    const fields = raw
      ? Object.entries(raw).filter(([, ok]) => ok).map(([k]) => FIELD_LABELS[k] ?? k)
      : []
    const existing = verificationMap.get(v.source_url)
    if (existing) {
      fields.forEach((f) => existing.confirmed.add(f))
    } else {
      verificationMap.set(v.source_url, {
        source_type: v.source_type as string,
        confirmed: new Set(fields),
      })
    }
  }
  const verifications = Array.from(verificationMap.entries()).map(([url, v]) => ({
    source_url: url,
    source_type: v.source_type,
    confirmed: Array.from(v.confirmed),
  }))

  // Extract and sanitize enrichment_data.found.
  // The pipeline stores raw web results without filtering — sanitize here.
  type RawFound = Record<string, unknown>
  const rawFound = (sightingRes.data?.enrichment_data as { found?: RawFound } | null)?.found ?? null

  const enrichmentFound = rawFound
    ? {
        date_start:       (rawFound.date_start as string | null) ?? null,
        time_start:       (rawFound.time_start as string | null) ?? null,
        location_address: (rawFound.location_address as string | null) ?? null,
        event_url:        sanitizeUrl(rawFound.event_url),
        contact:          sanitizeUrl(rawFound.contact),
        description:      sanitizeText(rawFound.description),
      }
    : null

  return NextResponse.json({
    boards: boardsRes.data ?? [],
    verifications,
    enrichment_found: enrichmentFound,
  })
}