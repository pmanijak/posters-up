'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { categoryColor, hexToRgba } from '@/lib/categories'
import { seenAgo, staleness } from '@/lib/dates'
import { sourceDomain } from '@/lib/format'

// ── Types ──────────────────────────────────────────────────────────────────

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

interface BoardLocation {
  board_id: string
  location_name: string | null
  board_description: string | null
  last_seen_at: string
  lat: number
  lng: number
  managed_by: string | null
  requires_entry_to_photograph: boolean | null
}

interface EnrichmentFound {
  date_start: string | null
  time_start: string | null
  location_address: string | null
  event_url: string | null
  contact: string | null
  description: string | null
}

interface TellMeMoreData {
  boards: BoardLocation[]
  verifications: { source_url: string; source_type: string; confirmed: string[] }[]
  enrichment_found: EnrichmentFound | null
}

interface Supplements {
  date: string | null
  address: string | null
  description: string | null
  link: string | null
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatTime(h: number, m: number): string {
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hour = h > 12 ? h - 12 : h === 0 ? 12 : h
  return m === 0 ? `${hour}${ampm}` : `${hour}:${String(m).padStart(2, '0')}${ampm}`
}

function formatDate(event: Event): string {
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

function formatFoundDate(dateStr: string, timeStr?: string | null): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const datePart = new Date(year, month - 1, day).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  })
  if (timeStr) {
    const [h, m] = timeStr.split(':').map(Number)
    return `${datePart} · ${formatTime(h, m)}`
  }
  return datePart
}

function formatTalent(talent: TalentEntry[]): string | null {
  if (!talent.length) return null
  return talent.map((t) => t.name).join(' · ')
}

function highlightText(text: string, query: string, color: string): ReactNode {
  if (!query.trim()) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  if (parts.length === 1) return text
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <span key={i} style={{ color, fontWeight: 500 }}>{part}</span>
      : part
  )
}

async function fetchTellMeMore(eventId: string): Promise<TellMeMoreData> {
  try {
    const res = await fetch(`/api/events/${eventId}/tell-me-more`)
    if (!res.ok) return { boards: [], verifications: [], enrichment_found: null }
    return await res.json()
  } catch {
    return { boards: [], verifications: [], enrichment_found: null }
  }
}

function getSupplements(event: Event, found: EnrichmentFound | null): Supplements {
  if (!found) return { date: null, address: null, description: null, link: null }
  return {
    date: event.date_type !== 'specific' && found.date_start
      ? formatFoundDate(found.date_start, found.time_start)
      : null,
    address:     !event.location_address             ? found.location_address : null,
    description: !event.description                  ? found.description      : null,
    link:        !(event.event_url ?? event.contact) ? (found.event_url ?? found.contact) : null,
  }
}

// ── Card ───────────────────────────────────────────────────────────────────

export function EventCard({ event }: { event: Event }) {
  const searchParams = useSearchParams()
  const [expanded, setExpanded] = useState(false)
  const [data, setData] = useState<TellMeMoreData | null>(null)
  const [loading, setLoading] = useState(false)

  const q           = searchParams.get('q') ?? ''
  const isMinimal   = event.flyer_style === 'minimal'
  const accentColor = categoryColor(event.event_category)
  const talentStr   = formatTalent(event.talent ?? [])
  const location    = event.venue_name ?? event.location_name

  const detailParts: string[] = []
  if (event.price_raw)         detailParts.push(event.price_raw)
  else if (event.is_free)      detailParts.push('Free')
  if (event.age_restriction)   detailParts.push(event.age_restriction)
  if (event.organization_name) detailParts.push(event.organization_name)

  const linkUrl  = event.event_url ?? event.contact
  const linkHref = linkUrl
    ? linkUrl.startsWith('http') ? linkUrl : `https://${linkUrl}`
    : null

  const hasSomethingToShow = linkHref !== null || event.sighting_count > 0

  function tagHref(tag: string): string {
    const params = new URLSearchParams(searchParams.toString())
    params.set('q', tag)
    return `/?${params.toString()}`
  }

  function tagIsActive(tag: string): boolean {
    return q.length > 0 && tag.toLowerCase().includes(q.toLowerCase())
  }

  async function handleToggle() {
    if (!expanded && data === null) {
      setLoading(true)
      setData(await fetchTellMeMore(event.id))
      setLoading(false)
    }
    setExpanded((v) => !v)
  }

  const supplements    = data ? getSupplements(event, data.enrichment_found) : null
  const hasSupplements = supplements !== null && Object.values(supplements).some(Boolean)

  return (
    <div className="rounded-sm overflow-hidden bg-surface-card">
      <div className="px-4 py-3">

        {/* Top row: date + category badge */}
        <div className="flex items-start justify-between gap-3 mb-1.5">
          <span className="text-xs font-mono tracking-wider text-content-muted">
            {formatDate(event)}
          </span>
          {event.event_category && (
            <span
              className="text-xs shrink-0 font-medium px-2 py-0.5 rounded"
              style={{ color: accentColor, background: hexToRgba(accentColor, 0.15) }}
            >
              {event.event_category.replace('_', ' ')}
            </span>
          )}
        </div>

        {/* Name */}
        <h2
          className="font-bold leading-snug mb-1"
          style={{ fontFamily: 'Georgia, serif', fontSize: '1.05rem', color: accentColor }}
        >
          {event.name}
        </h2>

        {/* Talent */}
        {talentStr && (
          <p className="text-sm mb-1 text-content-secondary">{talentStr}</p>
        )}

        {/* Location */}
        {location && (
          <p className="text-sm text-content-muted">
            {location}
            {event.location_address && !event.venue_name && (
              <span> · {event.location_address}</span>
            )}
          </p>
        )}

        {/* Description — standard/detailed only; highlight query matches */}
        {!isMinimal && event.description && (
          <p className="text-sm mt-2 leading-relaxed text-content-muted">
            {highlightText(event.description, q, accentColor)}
          </p>
        )}

        {/* Minimal: show description only if it's literally all we have */}
        {isMinimal && event.description && !location && !talentStr && (
          <p className="text-sm mt-1 leading-relaxed text-content-muted">
            {highlightText(event.description, q, accentColor)}
          </p>
        )}

        {/* Details row */}
        {detailParts.length > 0 && (
          <p className="text-sm mt-1.5 text-content-muted">
            {detailParts.join(' · ')}
          </p>
        )}

        {/* Flyer link */}
        {linkHref && (
          <a
            href={linkHref}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-xs mt-1.5"
            style={{ color: accentColor }}
          >
            {sourceDomain(linkHref)} →
          </a>
        )}

        {/* Tags */}
        {event.tags && event.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {event.tags.slice(0, 6).map((tag) => (
              <Link
                key={tag}
                href={tagHref(tag)}
                className="text-xs px-2 py-0.5 rounded-full transition-colors"
                style={
                  tagIsActive(tag)
                    ? { background: hexToRgba(accentColor, 0.15), color: accentColor }
                    : { background: 'var(--color-surface-raised)', color: 'var(--color-content-muted)' }
                }
              >
                {tag}
              </Link>
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
              {seenAgo(event.last_sighted_at)}
            </span>
          </div>
          {hasSomethingToShow && (
            <button
              type="button"
              onClick={handleToggle}
              className="text-xs text-content-muted"
            >
              {expanded ? 'Less ↑' : 'Find this poster ↓'}
            </button>
          )}
        </div>

        {/* ── Expansion ───────────────────────────────────────────────── */}
        {expanded && (
          <div className="mt-3 pt-3 border-t border-edge space-y-4">
            {loading ? (
              <p className="text-xs text-content-muted">Loading…</p>
            ) : (
              <>
                {data && data.boards.length > 0 ? (
                  <div>
                    {isMinimal && (
                      <p className="text-xs text-content-muted mb-2">
                        This flyer is your best source of info
                      </p>
                    )}
                    <ul className="space-y-2">
                      {data.boards.map((b) => {
                        const { label, fresh } = staleness(b.last_seen_at)
                        return (
                          <li key={b.board_id} className="flex items-start justify-between gap-4">
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <span className="text-sm text-content-secondary">
                                {b.location_name ?? b.board_description ?? '(unnamed board)'}
                              </span>
                              {b.location_name && b.board_description && (
                                <span className="text-xs text-content-muted">
                                  {b.board_description}
                                </span>
                              )}
                              {!b.location_name && (b.managed_by || b.requires_entry_to_photograph) && (
                                <span className="text-xs text-content-muted">
                                  {[
                                    b.managed_by,
                                    b.requires_entry_to_photograph ? 'go inside' : null,
                                  ].filter(Boolean).join(' · ')}
                                </span>
                              )}
                              {b.location_name && b.requires_entry_to_photograph && (
                                <span className="text-xs text-content-muted">go inside</span>
                              )}
                              <span className={`text-xs ${fresh ? 'text-content-accent' : 'text-content-muted'}`}>
                                {label}
                              </span>
                            </div>
                            {b.lat && b.lng && (
                              <Link
                                href={`/boards?board=${b.board_id}&lat=${b.lat}&lng=${b.lng}`}
                                className="text-xs text-content-muted hover:text-content-secondary transition-colors shrink-0 self-start"
                              >
                                Map →
                              </Link>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ) : data ? (
                  <p className="text-xs text-red-400/50">board data unavailable</p>
                ) : null}

                {!isMinimal && hasSupplements && supplements && (
                  <div className="space-y-1.5">
                    <p className="text-xs text-content-muted">Found online</p>
                    {supplements.date && (
                      <p className="text-sm text-content-secondary">{supplements.date}</p>
                    )}
                    {supplements.address && (
                      <p className="text-sm text-content-secondary">{supplements.address}</p>
                    )}
                    {supplements.description && (
                      <p className="text-sm leading-relaxed text-content-muted">
                        {supplements.description}
                      </p>
                    )}
                    {supplements.link && (
                      <a
                        href={supplements.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-xs"
                        style={{ color: accentColor }}
                      >
                        {sourceDomain(supplements.link)} →
                      </a>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

      </div>
    </div>
  )
}