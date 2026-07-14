'use client'

import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import React from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { categoryColor } from '@/lib/categories'
import { seenAgo, staleness, formatDate } from '@/lib/dates'
import { sourceDomain } from '@/lib/format'
import { withAlpha } from '@/lib/utils/color'
import type { EventRow, TalentEntry } from '@/lib/types/events'
import type { TellMeMoreData, EnrichmentData } from '@/lib/types/enrichment'

// ── Helpers ────────────────────────────────────────────────────────────────

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
  confirmedTalentNames,
}: {
  enrichment: EnrichmentData
  accentColor: string
  confirmedTalentNames: Set<string>
}) {
  // Narrative content: something worth reading, not just structural data.
  // Talent only counts if at least one *confirmed* entry has displayable
  // details — unconfirmed names may be OCR garble and must not surface links.
  const hasNarrativeContent =
    enrichment.description ||
    enrichment.talent?.some(t =>
      confirmedTalentNames.has(t.name.toLowerCase()) &&
      (t.bio || (t.genre?.length ?? 0) > 0 || (t.links?.length ?? 0) > 0)
    ) ||
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

      {/* Per-talent context — bio, genre, and links gated on confirmed.
          Unconfirmed names may be OCR variants; surfacing their links risks
          pointing to the wrong artist entirely. Name still shows in the card
          header via formatTalent, so nothing is lost by hiding the block. */}
      {enrichment.talent?.map((t) => {
        const isConfirmed = confirmedTalentNames.has(t.name.toLowerCase())
        const hasDetails = isConfirmed && (t.bio || (t.genre && t.genre.length > 0) || t.links.length > 0)
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

      {/* Venue context — only if it adds something the description didn't cover.
          Not sent to Claude in route.ts's formatForPrompt (dropped deliberately —
          low value for grouping relative to its token cost). Still shown here on
          the card since it's useful context for a human reading the full details. */}
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

export function EventCard({ event, defaultExpanded = false }: { event: EventRow; defaultExpanded?: boolean }) {
  const searchParams = useSearchParams()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [data, setData] = useState<TellMeMoreData | null>(null)
  // When defaultExpanded, loading starts true so the card opens in a loading
  // state without needing setLoading(true) inside the effect.
  const [loading, setLoading] = useState(defaultExpanded)

  // Auto-fetch on mount when starting in expanded state (e.g. dedicated event page).
  // setLoading(true) is deliberately absent — loading is initialized to defaultExpanded
  // above to avoid synchronous setState in the effect body.
  useEffect(() => {
    if (defaultExpanded) {
      fetchTellMeMore(event.id!).then(result => {
        setData(result)
        setLoading(false)
      })
    }
  }, [defaultExpanded, event.id])

  const q           = searchParams.get('q') ?? ''
  const tagParam    = searchParams.get('tag') ?? ''
  // Use whichever filter is active for text highlighting
  const highlight   = q || tagParam
  const isMinimal   = event.flyer_style === 'minimal'
  const accentColor = categoryColor(event.event_category)

  // talent is Json | null in EventRow; cast once here and use talent throughout.
  const talent      = (event.talent ?? []) as unknown as TalentEntry[]
  const talentStr   = formatTalent(talent)
  const location    = event.venue_name ?? event.location_name

  // Build confirmed set here so EventCard controls the gate, not EnrichmentSection.
  // Matched by lowercased name since enrichment_data keys talent by name, not ID.
  // confirmed is not yet in the events_public talent aggregate — see TalentEntry in
  // lib/types/events.ts for the TODO. Until the view is updated this set is always
  // empty, which means talent links and bios are suppressed (correct degraded behavior).
  const confirmedTalentNames = new Set(
    talent
      .filter(t => t.confirmed)
      .map(t => t.name.toLowerCase())
  )

  // Convenience — view columns are all nullable; these are NOT NULL in the base table.
  const sightingCount = event.sighting_count ?? 0

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

  function tagIsActive(t: string): boolean {
    if (q.length > 0)        return t.toLowerCase().includes(q.toLowerCase())
    if (tagParam.length > 0) return t.toLowerCase() === tagParam.toLowerCase()
    return false
  }

  async function handleToggle() {
    if (!expanded && data === null) {
      setLoading(true)
      setData(await fetchTellMeMore(event.id!))
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
              style={{ color: accentColor, background: withAlpha(accentColor, 0.15) }}
            >
              {event.event_category.replace('_', ' ')}
            </span>
          )}
        </div>

        {/* Name — links to the dedicated event page */}
        <h2
          className="font-bold leading-snug mb-1"
          style={{ fontFamily: 'Georgia, serif', fontSize: '1.05rem' }}
        >
          <Link
            href={`/events/${event.id}`}
            className="underline underline-offset-2 decoration-2 hover:[text-decoration-color:var(--link-deco-hover)]"
            style={{
              color: accentColor,
              textDecorationColor: withAlpha(accentColor, 0.35),
              '--link-deco-hover': withAlpha(accentColor, 0.85),
            } as React.CSSProperties}
          >
            {event.name}
          </Link>
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

        {/* Description — shown for standard/detailed always; for minimal only when
            it's the only content we have (no location, no talent listed) */}
        {event.description && (!isMinimal || (!location && !talentStr)) && (
          <p className={`text-sm leading-relaxed text-content-muted ${isMinimal ? 'mt-1' : 'mt-2'}`}>
            {highlightText(event.description, highlight, accentColor)}
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
                    ? { background: withAlpha(accentColor, 0.15), color: accentColor }
                    : { background: 'var(--color-surface-raised)', color: 'var(--color-content-muted)' }
                }
              >
                {tag}
              </Link>
            ))}
          </div>
        )}

        {/* Footer — meta row hidden on dedicated event page */}
        <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-edge">
          {!defaultExpanded ? (
            <div className="flex items-center gap-3">
              <span className="text-xs text-content-muted">
                {sightingCount} board{sightingCount !== 1 ? 's' : ''}
              </span>
              <span className="text-xs font-mono text-content-muted">
                {((event.confidence_score ?? 0) * 100).toFixed(0)}%
              </span>
              {isMinimal && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-surface-raised text-content-muted">
                  minimal
                </span>
              )}
              {event.last_sighted_at && (
                <span className="text-xs text-content-muted">
                  {seenAgo(event.last_sighted_at)}
                </span>
              )}
            </div>
          ) : (
            <div />
          )}
          {/* Show the toggle when the expansion has something to offer:
              enrichment content or board locations. The linkHref case is already
              rendered in the card body as its own <a> — it doesn't need a toggle. */}
          {((event.has_enrichment ?? false) || sightingCount > 0) && (
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
                    confirmedTalentNames={confirmedTalentNames}
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
                  <p className="text-xs text-danger/50">board data unavailable</p>
                ) : null}
              </>
            )}
          </div>
        )}

      </div>
    </div>
  )
}