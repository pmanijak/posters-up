// Shared date/time display utilities.
// Used by event-card.tsx and boards-near-me.tsx.

// Returns the difference in calendar days between now and a UTC timestamp,
// computed in Pacific time. Using elapsed milliseconds (/ 86_400_000) gives
// 0 for anything less than 24 hours ago, so a photo taken at 11pm last night
// would show "seen today" the next morning. Calendar days fix that.
function daysDiff(iso: string): number {
  const fmt   = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })
  const today = fmt.format(new Date())
  const then  = fmt.format(new Date(iso))
  // Both strings are YYYY-MM-DD; parsing them as Date gives local midnight,
  // so the difference is exact calendar days with no DST risk.
  return Math.round((new Date(today).getTime() - new Date(then).getTime()) / 86_400_000)
}

export function seenAgo(iso: string): string {
  const days = daysDiff(iso)
  if (days === 0) return 'seen today'
  if (days === 1) return 'seen yesterday'
  return `seen ${days}d ago`
}

// Returns the display label and whether the timestamp is recent enough
// to be considered "fresh" (accent color vs muted).
// Used for board last_sighted_at and event_sightings last_seen_at.
export function staleness(iso: string): { label: string; fresh: boolean } {
  const days = daysDiff(iso)
  if (days === 0) return { label: 'seen today',        fresh: true  }
  if (days === 1) return { label: 'seen yesterday',    fresh: true  }
  if (days <= 5)  return { label: `seen ${days}d ago`, fresh: true  }
  return             { label: `seen ${days}d ago`,     fresh: false }
}

// ── Event date/time display ────────────────────────────────────────────────

// Not exported — implementation detail used only by formatDate.
function formatTime(h: number, m: number): string {
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hour = h > 12 ? h - 12 : h === 0 ? 12 : h
  return m === 0 ? `${hour}${ampm}` : `${hour}:${String(m).padStart(2, '0')}${ampm}`
}

// Minimal interface for the fields formatDate needs.
// EventRow satisfies this structurally without an explicit import.
interface EventDateFields {
  date_type:  string | null
  date_start: string | null
  date_end:   string | null
  date_raw:   string | null
  time_start: string | null
}

export function formatDate(event: EventDateFields): string {
  if (event.date_type === 'specific' && event.date_start) {
    const [sy, sm, sd] = event.date_start.split('-').map(Number)
    const startStr = new Date(sy, sm - 1, sd)
      .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      .toUpperCase()

    let dateStr = startStr

    if (event.date_end && event.date_end !== event.date_start) {
      const [ey, em, ed] = event.date_end.split('-').map(Number)
      const endStr = new Date(ey, em - 1, ed)
        .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
        .toUpperCase()
      dateStr = `${startStr} – ${endStr}`
    }

    if (event.time_start) {
      const [h, m] = event.time_start.split(':').map(Number)
      return `${dateStr} · ${formatTime(h, m)}`
    }

    return dateStr
  }

  if (event.date_raw) return event.date_raw.toUpperCase()
  return 'DATE TBD'
}