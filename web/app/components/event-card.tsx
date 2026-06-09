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
    // Parse as local date to avoid timezone shifts
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
const CATEGORY_COLORS: Record<string, string> = {
  music:        '#B94A1F',
  film:         '#2D5F8A',
  theater:      '#6B4E8A',
  dance:        '#2A7A6F',
  comedy:       '#B07D1A',
  spoken_word:  '#4A7A4A',
  visual_art:   '#8A4A6B',
  market:       '#7A6B2A',
  lecture:      '#3A5F7A',
  workshop:     '#B06A2A',
  fitness:      '#2A6A4A',
  community:    '#2A5A7A',
  support_group:'#6A5A8A',
  fundraiser:   '#8A4A4A',
  party:        '#B07A1A',
}

function categoryColor(category: string | null): string {
  return category ? (CATEGORY_COLORS[category] ?? '#8A7E72') : '#8A7E72'
}

// ── Card ───────────────────────────────────────────────────────────────────

export function EventCard({ event }: { event: Event }) {
  const isMinimal = event.flyer_style === 'minimal'
  const accentColor = categoryColor(event.event_category)
  const talentStr = formatTalent(event.talent ?? [])

  // Location: prefer venue name, fall back to location_name
  const location = event.venue_name ?? event.location_name

  const cardContent = (
    <div
      className="rounded-sm overflow-hidden"
      style={{
        background: '#fff',
        borderLeft: `3px solid ${accentColor}`,
        boxShadow: '0 1px 3px rgba(28,23,19,0.06)',
      }}
    >
      <div className="px-4 py-3">

        {/* Top row: date + category */}
        <div className="flex items-start justify-between gap-3 mb-1.5">
          <span
            className="text-xs font-mono tracking-wider"
            style={{ color: '#8A7E72', letterSpacing: '0.05em' }}
          >
            {formatDate(event)}
          </span>
          {event.event_category && (
            <span
              className="text-xs shrink-0"
              style={{ color: accentColor, fontWeight: 500 }}
            >
              {event.event_category.replace('_', ' ')}
            </span>
          )}
        </div>

        {/* Name */}
        <h2
          className="font-bold leading-snug mb-1"
          style={{
            fontFamily: 'Georgia, serif',
            fontSize: '1.05rem',
            color: '#1C1713',
          }}
        >
          {event.name}
        </h2>

        {/* Talent */}
        {talentStr && (
          <p className="text-sm mb-1" style={{ color: '#4A3F36' }}>
            {talentStr}
          </p>
        )}

        {/* Location */}
        {location && (
          <p className="text-sm" style={{ color: '#6A5F56' }}>
            {location}
            {event.location_address && !event.venue_name && (
              <span style={{ color: '#8A7E72' }}> · {event.location_address}</span>
            )}
          </p>
        )}

        {/* Description — only for standard/detailed */}
        {!isMinimal && event.description && (
          <p
            className="text-sm mt-2 leading-relaxed"
            style={{ color: '#6A5F56' }}
          >
            {event.description}
          </p>
        )}

        {/* For minimal: show description if it's the only info we have */}
        {isMinimal && event.description && !location && !talentStr && (
          <p
            className="text-sm mt-1 leading-relaxed"
            style={{ color: '#6A5F56' }}
          >
            {event.description}
          </p>
        )}

        {/* Inline details row: price, age, org */}
        {(() => {
          const details: string[] = []
          if (event.price_raw) details.push(event.price_raw)
          else if (event.is_free) details.push('Free')
          if (event.age_restriction) details.push(event.age_restriction)
          if (event.organization_name) details.push(event.organization_name)
          if (!details.length) return null
          return (
            <p className="text-sm mt-1.5" style={{ color: '#8A7E72' }}>
              {details.join(' · ')}
            </p>
          )
        })()}

        {/* Tags */}
        {event.tags && event.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {event.tags.slice(0, 6).map((tag) => (
              <span
                key={tag}
                className="text-xs px-2 py-0.5 rounded-full"
                style={{
                  background: '#F0EBE3',
                  color: '#8A7E72',
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Footer: meta + link */}
        <div
          className="flex items-center justify-between mt-3 pt-2.5"
          style={{ borderTop: '1px solid #F0EBE3' }}
        >
          <div className="flex items-center gap-3">
            {/* Sightings */}
            <span className="text-xs" style={{ color: '#B0A898' }}>
              {event.sighting_count} board{event.sighting_count !== 1 ? 's' : ''}
            </span>

            {/* Confidence */}
            <span className="text-xs font-mono" style={{ color: '#B0A898' }}>
              {(event.confidence_score * 100).toFixed(0)}%
            </span>

            {/* Flyer style — only show for minimal, it's informative */}
            {isMinimal && (
              <span
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: '#F0EBE3', color: '#8A7E72' }}
              >
                minimal
              </span>
            )}

            {/* Last seen */}
            <span className="text-xs" style={{ color: '#C8BEB4' }}>
              {lastSeen(event.last_sighted_at)}
            </span>
          </div>

          {/* Link */}
          {event.event_url && (
            <a
              href={event.event_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs"
              style={{ color: accentColor }}
            >
              Details →
            </a>
          )}
          {!event.event_url && event.contact && (
            <a
              href={event.contact.startsWith('http') ? event.contact : `https://${event.contact}`}
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

  return cardContent
}