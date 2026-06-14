// app/components/event-card.tsx

interface TalentEntry {
  id: string
  name: string
  talent_type: string | null
  role: string | null
  billing_position: number | null
}

interface Event {
  id: string
  name: string
  content_type: string
  event_category: string | null
  tags: string[] | null
  flyer_style: 'minimal' | 'standard' | 'detailed' | null
  date_type: 'specific' | 'recurring' | 'approximate' | 'unknown'
  date_start: string | null
  date_end: string | null
  time_start: string | null
  time_end: string | null
  recurrence_rule: string | null
  date_raw: string | null
  location_name: string | null
  location_address: string | null
  description: string | null
  contact: string | null
  event_url: string | null
  price_raw: string | null
  is_free: boolean | null
  age_restriction: string | null
  is_outdoor: boolean | null
  accessibility: string[] | null
  confidence_score: number
  sighting_count: number
  last_sighted_at: string
  organization_name: string | null
  venue_name: string | null
  talent: TalentEntry[]
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(event: Event): string {
  if (event.date_type === 'specific' && event.date_start) {
    const [year, month, day] = event.date_start.split('-').map(Number)
    const date = new Date(year, month - 1, day)
    const dateStr = date
      .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      .toUpperCase()

    if (event.time_start) {
      const [h, m] = event.time_start.split(':').map(Number)
      const ampm = h >= 12 ? 'PM' : 'AM'
      const hour = h > 12 ? h - 12 : h === 0 ? 12 : h
      const time = m === 0 ? `${hour}${ampm}` : `${hour}:${String(m).padStart(2, '0')}${ampm}`
      return `${dateStr} · ${time}`
    }
    return dateStr
  }

  if (event.date_raw) return event.date_raw.toUpperCase()
  return 'DATE TBD'
}

function lastSeen(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days === 0) return 'seen today'
  if (days === 1) return 'seen yesterday'
  return `seen ${days}d ago`
}

function formatTalent(talent: TalentEntry[]): string | null {
  if (!talent.length) return null
  return talent.map((t) => t.name).join(' · ')
}

// Category → left-border accent color
// These stay as inline styles since they're dynamic per-event values,
// not part of the global theme.
const CATEGORY_COLORS: Record<string, string> = {
  music:         '#D4956A',  // warm amber
  film:          '#7A9EC4',  // slate blue
  theater:       '#B48AC4',  // muted purple
  dance:         '#7ABDB4',  // teal
  comedy:        '#D4B86A',  // golden
  spoken_word:   '#9AB47A',  // sage
  visual_art:    '#C48AAA',  // dusty rose
  market:        '#C4AA7A',  // tan
  lecture:       '#7A9EB4',  // steel blue
  workshop:      '#C4956A',  // terracotta
  fitness:       '#7AC49A',  // mint
  community:     '#7AAAC4',  // sky
  support_group: '#A49AC4',  // lavender
  fundraiser:    '#C4A07A',  // sand
  party:         '#D4B86A',  // golden
}

function categoryColor(category: string | null): string {
  return category ? (CATEGORY_COLORS[category] ?? '#8A9E8F') : '#8A9E8F'
}

// ── Card ───────────────────────────────────────────────────────────────────

export function EventCard({ event }: { event: Event }) {
  const isMinimal = event.flyer_style === 'minimal'
  const accentColor = categoryColor(event.event_category)
  const talentStr = formatTalent(event.talent ?? [])
  const location = event.venue_name ?? event.location_name

  const detailParts: string[] = []
  if (event.price_raw) detailParts.push(event.price_raw)
  else if (event.is_free) detailParts.push('Free')
  if (event.age_restriction) detailParts.push(event.age_restriction)
  if (event.organization_name) detailParts.push(event.organization_name)

  const linkUrl = event.event_url ?? event.contact
  const linkHref = linkUrl
    ? linkUrl.startsWith('http') ? linkUrl : `https://${linkUrl}`
    : null

  return (
    <div
      className="rounded-sm overflow-hidden bg-surface-card"
      style={{ borderLeft: `3px solid ${accentColor}` }}
    >
      <div className="px-4 py-3">

        {/* Top row: date + category */}
        <div className="flex items-start justify-between gap-3 mb-1.5">
          <span className="text-xs font-mono tracking-wider text-content-muted">
            {formatDate(event)}
          </span>
          {event.event_category && (
            <span className="text-xs shrink-0 font-medium" style={{ color: accentColor }}>
              {event.event_category.replace('_', ' ')}
            </span>
          )}
        </div>

        {/* Name */}
        <h2 className="font-bold leading-snug mb-1 text-content-primary" style={{ fontFamily: 'Georgia, serif', fontSize: '1.05rem' }}>
          {event.name}
        </h2>

        {/* Talent */}
        {talentStr && (
          <p className="text-sm mb-1 text-content-secondary">
            {talentStr}
          </p>
        )}

        {/* Location */}
        {location && (
          <p className="text-sm text-content-muted">
            {location}
            {event.location_address && !event.venue_name && (
              <span className="text-content-muted"> · {event.location_address}</span>
            )}
          </p>
        )}

        {/* Description — standard/detailed only */}
        {!isMinimal && event.description && (
          <p className="text-sm mt-2 leading-relaxed text-content-muted">
            {event.description}
          </p>
        )}

        {/* Minimal: show description only if it's all we have */}
        {isMinimal && event.description && !location && !talentStr && (
          <p className="text-sm mt-1 leading-relaxed text-content-muted">
            {event.description}
          </p>
        )}

        {/* Details row: price, age, org */}
        {detailParts.length > 0 && (
          <p className="text-sm mt-1.5 text-content-muted">
            {detailParts.join(' · ')}
          </p>
        )}

        {/* Tags */}
        {event.tags && event.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {event.tags.slice(0, 6).map((tag) => (
              <span
                key={tag}
                className="text-xs px-2 py-0.5 rounded-full bg-surface-raised text-content-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-edge">
          <div className="flex items-center gap-3">
            <span className="text-xs text-content-muted">
              {event.sighting_count} board{event.sighting_count !== 1 ? 's' : ''}
            </span>
            <span className="text-xs font-mono text-content-muted">
              {(event.confidence_score * 100).toFixed(0)}%
            </span>
            {isMinimal && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-surface-raised text-content-muted">
                minimal
              </span>
            )}
            <span className="text-xs text-content-muted">
              {lastSeen(event.last_sighted_at)}
            </span>
          </div>

          {linkHref && (
            <a
              href={linkHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs"
              style={{ color: accentColor }}
            >
              Details →
            </a>
          )}
        </div>
      </div>
    </div>
  )
}