'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { categoryColor, hexToRgba } from '@/lib/categories'
import { seenAgo, staleness } from '@/lib/dates'
import { sourceDomain } from '@/lib/format'
import type { TellMeMoreData, EnrichmentData } from '@/lib/types/enrichment'

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
  has_enrichment: boolean
  organization_name: string | null
  venue_name: string | null
  talent: TalentEntry[]
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
    if (!res.ok) return { boards: [], enrichment: null }
    return await res.json()
  } catch {
    return { boards: [], enrichment: null }
  }
}

// ── Enrichment section ─────────────────────────────────────────────────────

function EnrichmentSection({
  enrichment,
  accentColor,
}: {
  enrichment: EnrichmentData
  accentColor: string
}) {
  // Narrative content: something worth reading, not just structural data.
  // Talent only counts if at least one entry has displayable details —
  // a name-only entry with no bio, genre, or links renders nothing.
  const hasNarrativeContent =
    enrichment.description ||
    enrichment.talent?.some(t => t.bio || (t.genre?.length ?? 0) > 0 || (t.links?.length ?? 0) > 0) ||
    enrichment.venue_context

  const hasAnything =
    hasNarrativeContent ||
    enrichment.ticket_url ||
    enrichment.found?.location_address ||
    enrichment.found?.event_url

  if (!hasAnything) return null

  return (
    <div className="space-y-3">
      {/* Header and sources only when there's something worth reading */}
      {hasNarrativeContent && (
        <p className="text-xs text-content-muted uppercase tracking-wider">Found online</p>
      )}

      {/* Narrative description — the main thing */}
      {enrichment.description && (
        <p className="text-sm leading-relaxed text-content-secondary">
          {enrichment.description}
        </p>
      )}

      {/* Primary link — ticket or event URL, right after the description */}
      {enrichment.ticket_url ? (
        <a
          href={enrichment.ticket_url}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-xs font-medium"
          style={{ color: enrichment.sold_out ? 'var(--color-content-muted)' : accentColor }}
        >
          {enrichment.sold_out ? 'Sold out' : 'Get tickets →'}
        </a>
      ) : enrichment.found?.event_url ? (
        <a
          href={enrichment.found.event_url}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-xs"
          style={{ color: accentColor }}
        >
          {sourceDomain(enrichment.found.event_url)} →
        </a>
      ) : null}

      {/* Per-talent context */}
      {enrichment.talent?.map((t) => {
        const hasDetails = t.bio || (t.genre && t.genre.length > 0) || t.links.length > 0
        if (!hasDetails) return null
        return (
          <div key={t.name} className="space-y-1">
            <p className="text-xs font-medium text-content-secondary">{t.name}</p>
            {t.bio && (
              <p className="text-xs leading-relaxed text-content-muted">{t.bio}</p>
            )}
            {t.genre && t.genre.length > 0 && (
              <p className="text-xs text-content-muted">{t.genre.join(' · ')}</p>
            )}
            {t.links.length > 0 && (
              <div className="flex flex-wrap gap-3">
                {t.links.map((l) => (
                  <a
                    key={l.url}
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs"
                    style={{ color: accentColor }}
                  >
                    {l.label} →
                  </a>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {/* Venue context — only if it adds something the description didn't cover */}
      {enrichment.venue_context && (
        <p className="text-xs leading-relaxed text-content-muted">
          {enrichment.venue_context}
        </p>
      )}

      {/* Address gap-fill — only if the flyer didn't have it */}
      {enrichment.found?.location_address && (
        <p className="text-xs text-content-muted">{enrichment.found.location_address}</p>
      )}

      {/* Source attribution — only when there's narrative content to attribute */}
      {hasNarrativeContent && (enrichment.sources?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pt-1">
          <span className="text-xs text-content-muted">Sources:</span>
          {enrichment.sources.map((s) => (
            <a
              key={s.url}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-content-muted hover:text-content-secondary transition-colors underline"
            >
              {s.label}
            </a>
          ))}
        </div>
      )}
    </div>
  )
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

  const collapsedLabel = (!isMinimal && event.has_enrichment)
    ? 'Tell me more ↓'
    : 'Find this poster ↓'

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
          {(linkHref !== null || event.sighting_count > 0) && (
            <button
              type="button"
              onClick={handleToggle}
              className="text-xs text-content-muted"
            >
              {expanded ? 'Less ↑' : collapsedLabel}
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
                {/* Enrichment — suppressed for minimal flyers */}
                {!isMinimal && data?.enrichment && (
                  <EnrichmentSection
                    enrichment={data.enrichment}
                    accentColor={accentColor}
                  />
                )}

                {/* Board locations */}
                {data && data.boards.length > 0 ? (
                  <div>
                    <p className="text-xs text-content-muted mb-2">
                      {isMinimal
                        ? 'This flyer is your best source of info'
                        : 'Spotted on these boards'}
                    </p>
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
              </>
            )}
          </div>
        )}

      </div>
    </div>
  )
}