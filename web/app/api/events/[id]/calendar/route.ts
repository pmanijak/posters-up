// app/events/[id]/calendar/route.ts
import { createClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'

// ICS spec requires CRLF line endings and folding at 75 octets.
function fold(line: string): string {
  const bytes = new TextEncoder()
  if (bytes.encode(line).length <= 75) return line
  const chars = [...line]
  const chunks: string[] = []
  let current = ''
  for (const char of chars) {
    const candidate = current + char
    if (bytes.encode(candidate).length > 75) {
      chunks.push(current)
      current = ' ' + char  // folded continuation starts with a space
    } else {
      current = candidate
    }
  }
  if (current) chunks.push(current)
  return chunks.join('\r\n')
}

function escapeICS(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

// Format a date + optional time into ICS DTSTART/DTEND format.
// If no time provided, emits a DATE value (all-day).
// Events are in local time — ICS floating time is intentional here;
// we don't know the timezone of every venue and don't want to lie about it.
function formatDate(date: string, time: string | null): string {
  const d = date.replace(/-/g, '')
  if (!time) return `VALUE=DATE:${d}`
  const t = time.replace(/:/g, '').slice(0, 6).padEnd(6, '0')
  return `:${d}T${t}`
}

function formatEndDate(date: string | null, startDate: string, time: string | null): string {
  // If no end date, use start date (same-day event or all-day)
  const d = (date ?? startDate).replace(/-/g, '')
  if (!time) {
    // All-day: DTEND is exclusive next day per ICS spec
    const next = new Date(date ?? startDate)
    next.setDate(next.getDate() + 1)
    return `VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, '')}`
  }
  const t = time.replace(/:/g, '').slice(0, 6).padEnd(6, '0')
  return `:${d}T${t}`
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = createClient()

  const { data: event, error } = await supabase
    .from('events_public')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !event || event.date_type !== 'specific' || !event.date_start) {
    return new NextResponse('Event not found or not calendar-ready', { status: 404 })
  }

  // Nearest active board — for the "check board" description note
  const { data: boards } = await supabase
    .from('event_board_locations')
    .select('board_description, last_seen_at')
    .eq('event_id', id)
    .order('last_seen_at', { ascending: false })
    .limit(1)

  const board = boards?.[0] ?? null

  // Build description
  const descParts: string[] = []
  if (event.description) descParts.push(event.description)
  if (board?.board_description) {
    const lastSeen = new Date(board.last_seen_at).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric'
    })
    descParts.push(`Check the board at ${board.board_description} for details — last seen ${lastSeen}.`)
  }
  if (event.event_url) descParts.push(event.event_url)
  const description = descParts.join('\n')

  // Location: prefer address, fall back to name
  const location = [event.location_address, event.location_name]
    .filter(Boolean)
    .join(', ')

  const dtstart = formatDate(event.date_start, event.time_start ?? null)
  const dtend   = formatEndDate(event.date_end ?? null, event.date_start, event.time_end ?? event.time_start ?? null)
  const dtstamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z'

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Posters Up//postersup.org//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.id}@postersup.org`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART${dtstart}`,
    `DTEND${dtend}`,
    fold(`SUMMARY:${escapeICS(event.name)}`),
    ...(location          ? [fold(`LOCATION:${escapeICS(location)}`)]          : []),
    ...(description       ? [fold(`DESCRIPTION:${escapeICS(description)}`)]    : []),
    ...(event.event_url   ? [fold(`URL:${event.event_url}`)]                   : []),
    ...(event.price_raw   ? [fold(`X-COST:${escapeICS(event.price_raw)}`)]     : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ]

  const ics = lines.join('\r\n')
  const slug = event.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  return new NextResponse(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slug}.ics"`,
      'Cache-Control': 'no-store',
    },
  })
}