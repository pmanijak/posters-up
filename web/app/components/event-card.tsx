'use client'

import { useState } from 'react'
import { categoryColor, hexToRgba } from '@/lib/categories'

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
  board_description: string | null
  board_type: string | null
  last_seen_at: string
}

interface Verification {
  source_url: string
  source_type: string
  confirmed: string[]
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
  verifications: Verification[]
  enrichment_found: EnrichmentFound | null
}

// ── Constants ──────────────────────────────────────────────────────────────

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

function formatFoundDate(dateStr: string, timeStr?: string | null): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  const datePart = date.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  })
  if (timeStr) {
    const [h, m] = timeStr.split(':').map(Number)
    const ampm = h >= 12 ? 'PM' : 'AM'
    const hour = h > 12 ? h - 12 : h === 0 ? 12 : h
    const timePart = m === 0
      ? `${hour}${ampm}`
      : `${hour}:${String(m).padStart(2, '0')}${ampm}`
    return `${datePart} · ${timePart}`
  }
  return datePart
}

function seenAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days === 0) return 'seen today'
  if (days === 1) return 'seen yesterday'
  return `seen ${days}d ago`
}

function sourceDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') }
  catch { return url }
}

function formatTalent(talent: TalentEntry[]): string | null {
  if (!talent.length) return null
  return talent.map((t) => t.name).join(' · ')
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

// ── Found supplement helpers ───────────────────────────────────────────────
//
// Only surface enrichment values that add something the flyer didn't have.
// If the flyer already has a date, showing the web-found date is redundant.
// If the flyer had no address but we found one, that's genuinely useful.

interface Supplements {
  date: string | null
  address: string | null
  description: string | null
  link: string | null  // event_url ?? contact from enrichment
}

function getSupplements(event: Event, found: EnrichmentFound | null): Supplements {
  if (!found) return { date: null, address: null, description: null, link: null }

  return {
    // Date: only when the flyer didn't have a specific date
    date: event.date_type !== 'specific' && found.date_start
      ? formatFoundDate(found.date_start, found.time_start)
      : null,

    // Address: only when the flyer had none
    address: !event.location_address ? found.location_address : null,

    // Description: only when the flyer had none
    description: !event.description ? found.description : null,

    // Link: only when the event record has no external link already
    link: !(event.event_url ?? event.contact)
      ? (found.event_url ?? found.contact)
      : null,
  }
}

// ── Card ───────────────────────────────────────────────────────────────────

export function EventCard({ event }: { event: Event }) {
  const [expanded, setExpanded] = useState(false)
  const [data, setData] = useState<TellMeMoreData | null>(null)
  const [loading, setLoading] = useState(false)

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

  async function handleToggle() {
    if (!expanded && data === null) {
      setLoading(true)
      setData(await fetchTellMeMore(event.id))
      setLoading(false)
    }
    setExpanded((v) => !v)
  }

  const supplements = data ? getSupplements(event, data.enrichment_found) : null
  const hasSupplements = supplements && Object.values(supplements).some(Boolean)

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

        {/* Description — standard/detailed only */}
        {!isMinimal && event.description && (
          <p className="text-sm mt-2 leading-relaxed text-content-muted">
            {event.description}
          </p>
        )}

        {/* Minimal: show description only if it's literally all we have */}
        {isMinimal && event.description && !location && !talentStr && (
          <p className="text-sm mt-1 leading-relaxed text-content-muted">
            {event.description}
          </p>
        )}

        {/* Details row */}
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
              {seenAgo(event.last_sighted_at)}
            </span>
          </div>
          <button
            onClick={handleToggle}
            className="text-xs"
            style={{ color: accentColor }}
          >
            {expanded ? 'Less ↑' : 'Tell me more ↓'}
          </button>
        </div>

        {/* ── Expansion ───────────────────────────────────────────────── */}
        {expanded && (
          <div className="mt-3 pt-3 border-t border-edge space-y-4">
            {loading ? (
              <p className="text-xs text-content-muted">Loading…</p>
            ) : (
              <>
                {/* SPOTTED AT
                    Primary answer for minimal events — the board has what the
                    flyer intentionally left out. Secondary context for others. */}
                {data && data.boards.length > 0 ? (
                  <div>
                    <p className="text-xs font-mono tracking-wider text-content-muted mb-2">
                      SPOTTED AT
                    </p>
                    <ul className="space-y-2">
                      {data.boards.map((b) => (
                        <li key={b.board_id} className="flex items-baseline justify-between gap-4">
                          <span className="text-sm text-content-secondary">
                            {b.board_description ?? b.board_type ?? 'Community board'}
                          </span>
                          <span className="text-xs text-content-muted shrink-0">
                            {seenAgo(b.last_seen_at)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {isMinimal && (
                      <p className="text-xs text-content-muted mt-2">
                        This flyer is intentionally minimal — the board will have more.
                      </p>
                    )}
                  </div>
                ) : data ? (
                  <p className="text-xs text-content-muted">No active boards on file.</p>
                ) : null}

                {/* Found values — only what's missing from the flyer.
                    No source list; the information speaks for itself.
                    Never shown for minimal events. */}
                {!isMinimal && hasSupplements && (
                  <div className="space-y-1.5">
                    {supplements!.date && (
                      <p className="text-sm text-content-secondary">
                        {supplements!.date}
                      </p>
                    )}
                    {supplements!.address && (
                      <p className="text-sm text-content-secondary">
                        {supplements!.address}
                      </p>
                    )}
                    {supplements!.description && (
                      <p className="text-sm leading-relaxed text-content-muted">
                        {supplements!.description}
                      </p>
                    )}
                    {supplements!.link && (
                      <a
                        href={supplements!.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-xs"
                        style={{ color: accentColor }}
                      >
                        {sourceDomain(supplements!.link)} →
                      </a>
                    )}
                  </div>
                )}

                {/* Flyer's own external link — shown last when present */}
                {linkHref && (
                  <a
                    href={linkHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-xs"
                    style={{ color: accentColor }}
                  >
                    More info →
                  </a>
                )}
              </>
            )}
          </div>
        )}

      </div>
    </div>
  )
}