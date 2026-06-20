// Shared date/time display utilities.
// Used by event-card.tsx and boards-near-me.tsx.

export function seenAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days === 0) return 'seen today'
  if (days === 1) return 'seen yesterday'
  return `seen ${days}d ago`
}

// Returns the display label and whether the timestamp is recent enough
// to be considered "fresh" (accent color vs muted).
// Used for board last_sighted_at and event_sightings last_seen_at.
export function staleness(iso: string): { label: string; fresh: boolean } {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days === 0) return { label: 'seen today',        fresh: true  }
  if (days === 1) return { label: 'seen yesterday',    fresh: true  }
  if (days <= 5)  return { label: `seen ${days}d ago`, fresh: true  }
  return             { label: `seen ${days}d ago`,     fresh: false }
}