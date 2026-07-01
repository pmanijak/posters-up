import type { Metadata } from 'next'
import { Suspense } from 'react'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.generated'
import Link from 'next/link'

import { SITE_TITLE, SITE_DESCRIPTION, SITE_URL } from '@/lib/site'
import { FiltersProvider } from './components/filters-provider'
import { FilterBar } from './components/filter-bar'
import { SearchInput } from './components/search-input'
import { SearchResults } from './components/search-results'
import { EventCard } from './components/event-card'
import { EventFeed } from './components/event-feed'
import { AboutCard } from './components/about-card'
import { TagCard } from './components/tag-card'
import { CityPicker, type CityOption } from './components/city-picker'
import { PageHeader } from './components/page-header'
import { resolveLocation } from '@/lib/location'
import { buildCityOptions } from '@/lib/cities'
import { CATEGORY_MAP } from '@/lib/categories'

export const metadata: Metadata = {
  title:       SITE_TITLE,
  description: SITE_DESCRIPTION,
  openGraph: {
    title:       SITE_TITLE,
    description: SITE_DESCRIPTION,
    url:         SITE_URL,
    siteName:    SITE_TITLE,
    type:        'website',
    images:      [{ url: '/og.jpg', width: 1200, height: 630 }],
  },
  twitter: {
    card:        'summary_large_image',
    title:       SITE_TITLE,
    description: SITE_DESCRIPTION,
    images:      ['/og.jpg'],
  },
}

type EventRow = Database['public']['Views']['events_public']['Row']

const supabase = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!
)

// Extracted into a plain function so the linter doesn't flag Date.now() as an
// impure call inside a component. DiscoverPage is an async server component and
// the purity rule doesn't actually apply, but the linter can't tell the difference.
function getDateWindow() {
  // `now` subtracts 3 hours so late-night events (e.g. a midnight show) remain
  // visible the next morning rather than dropping off at midnight Pacific.
  // `fourDaysOut` uses Date.now() directly (not `now`) — it only controls the
  // AboutCard injection point, not DB filtering, so the 3-hour offset would just
  // shift the card position unnecessarily.
  const pacificTime = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })
  const now = Date.now() - 3 * 60 * 60 * 1000
  return {
    today:         pacificTime.format(new Date(now)),
    fourDaysOut:   pacificTime.format(new Date(Date.now() + 4  * 24 * 60 * 60 * 1000)),
    thirtyDaysOut: pacificTime.format(new Date(now + 30 * 24 * 60 * 60 * 1000)),
  }
}

interface SearchParams {
  category?: string
  q?:        string
  tag?:      string  // set by TagCard links; distinct from q (event card tags)
  lat?:      string
  lng?:      string
}

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const { category, q, tag, lat: latParam, lng: lngParam } = await searchParams

  const location = await resolveLocation(latParam, lngParam)
  const { lat, lng } = location

  const { today, fourDaysOut, thirtyDaysOut } = getDateWindow()

  const { data: nearbyBoards } = await supabase.rpc('boards_near', { lat, lng })
  const nearbyBoardIds = (nearbyBoards ?? []).map((b: { id: string }) => b.id)
  const cityLabel      = (nearbyBoards ?? [])[0]?.geo_city ?? null

  const noBoardsNearby = nearbyBoardIds.length === 0

  const { data: rawCities } = await supabase.rpc('available_cities')
  const availableCities: CityOption[] = buildCityOptions(rawCities ?? [])

  // Fetch the full unfiltered nearby set. q/category are applied in JS below
  // so that topTags always reflects everything nearby, not just the filtered slice —
  // this keeps the tag card useful for switching between vibes.
  let baseEvents: EventRow[] = []

  if (!noBoardsNearby) {
    const { data: events, error } = await supabase
      .rpc('events_for_boards', { board_ids: nearbyBoardIds })
      .or(
        `and(date_start.lte.${thirtyDaysOut},or(date_end.gte.${today},and(date_end.is.null,date_start.gte.${today}))),date_type.in.(recurring,approximate,unknown)`
      )
      .limit(500)

    if (error) {
      console.error('events_public query failed:', error)
    }

    baseEvents = events ?? []
  }

  // Apply text, tag, and category filters in JS so baseEvents stays available for topTags.
  let eventList: EventRow[] = baseEvents
  if (q) {
    const qLower = q.toLowerCase()
    eventList = eventList.filter(e => e.search_text?.toLowerCase().includes(qLower))
  }
  if (tag) {
    // Exact match — tag always originates from the tag cloud so we know the value precisely.
    const tagLower = tag.toLowerCase()
    eventList = eventList.filter(e => e.tags?.some(t => t.toLowerCase() === tagLower))
  }
  if (category && category !== 'all' && !q && !tag) {
    eventList = eventList.filter(e => e.event_category === category)
  }

  const DATE_TYPE_PRIORITY: Record<string, number> = {
    specific:    0,
    recurring:   1,
    approximate: 2,
    unknown:     3,
  }

  eventList = [...eventList].sort((a, b) => {
    const pa = DATE_TYPE_PRIORITY[a.date_type ?? ''] ?? 3
    const pb = DATE_TYPE_PRIORITY[b.date_type ?? ''] ?? 3
    if (pa !== pb) return pa - pb

    const sortKey = (e: EventRow): string | null => {
      if (e.date_type !== 'specific') return null
      if (e.date_start && e.date_start > today) return e.date_start
      return e.date_end ?? e.date_start
    }

    const ka = sortKey(a)
    const kb = sortKey(b)
    if (!ka && !kb) return 0
    if (!ka) return 1
    if (!kb) return -1
    return ka.localeCompare(kb)
  })

  if (q && category && category !== 'all') {
    eventList = [
      ...eventList.filter(e => e.event_category === category),
      ...eventList.filter(e => e.event_category !== category),
    ]
  }

  // About card injection — only in the unfiltered default view.
  // Scans the sorted list for the first natural break: a non-specific event
  // (recurring, approximate, unknown) or a specific event past the 4-day window.
  // That break point is where the About card slots in.
  // Minimum position of 3 so it never appears at the very top.
  // Suppressed when viewing a specific board — the context is already scoped.
  const isFiltered = !!(q || tag || (category && category !== 'all'))
  let aboutAt = eventList.length
  if (!isFiltered) {
    const MIN_POSITION = 3
    for (let i = 0; i < eventList.length; i++) {
      const e = eventList[i]
      if (e.date_type !== 'specific' || !e.date_start || e.date_start > fourDaysOut) {
        aboutAt = Math.max(i, MIN_POSITION)
        break
      }
    }
  }

  // Derive top tags from the full unfiltered baseEvents so the tag card always
  // shows everything nearby — not just tags of the currently filtered slice.
  // Category names and the current city are filtered out as redundant.
  const CATEGORY_NAMES = new Set(Object.keys(CATEGORY_MAP))
  const cityLower      = cityLabel?.toLowerCase() ?? null

  const tagFrequency = new Map<string, number>()
  for (const event of baseEvents) {
    for (const tag of event.tags ?? []) {
      const tagLower = tag.toLowerCase()
      if (CATEGORY_NAMES.has(tagLower)) continue
      if (cityLower && tagLower === cityLower) continue
      tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1)
    }
  }
  const topTags = [...tagFrequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag]) => tag)

  // TagCard injects 5 cards after the AboutCard. Falls through to end-of-list
  // if the feed is too short, same pattern as AboutCard.
  const tagCardAt = aboutAt + 5

  return (
    <div className="min-h-screen bg-surface-page">

      <PageHeader
        cityLabel={cityLabel}
        cities={availableCities}
        isDetected={location.source !== 'cookie'}
      />

      <Suspense fallback={<FallbackState/>}>
        <FiltersProvider initialQuery={q}>

          <div className="sticky top-0 z-10 bg-surface-page">
            <div className="max-w-2xl mx-auto px-4 pt-2 pb-4">
              <FilterBar activeCategory={category} />
            </div>
          </div>

          {/* Search input — promoted above the category bar; owns the feed surface
              when a search is active */}
          <div className="max-w-2xl mx-auto px-4 pb-4">
            <SearchInput eventCount={eventList.length} />
          </div>

          {/* Tag card below search only when navigated from the tag cloud (?tag=).
              Event card tag clicks (?q=) don't pin it — different intent. */}
          {tag && topTags.length >= 5 && (
            <div className="max-w-2xl mx-auto px-4 pb-4">
              <TagCard tags={topTags} activeTag={tag} />
            </div>
          )}

          <main className="max-w-2xl mx-auto px-4">
            {noBoardsNearby ? (
              availableCities.length > 0 ? (
                <CityPicker cities={availableCities} />
              ) : (
                <NoBoardsState />
              )
            ) : (
              <>
                {/* Interpreted results render here, in the feed surface.
                    Self-gates to null when there's no active search. */}
                <SearchResults />

                <EventFeed>
                  {eventList.length === 0 ? (
                    <EmptyState category={category} q={q} />
                  ) : (
                    <div className="space-y-3">
                      {eventList.flatMap((event, i) => {
                        const cards = []
                        if (!isFiltered && i === aboutAt) cards.push(<AboutCard key="__about" />)
                        if (!isFiltered && !q && !tag && topTags.length >= 5 && i === tagCardAt) cards.push(<TagCard key="__tags" tags={topTags} />)
                        cards.push(<EventCard key={event.id} event={event} />)
                        return cards
                      })}
                      {!isFiltered && aboutAt >= eventList.length && <AboutCard key="__about" />}
                      {!isFiltered && !q && !tag && topTags.length >= 5 && tagCardAt >= eventList.length && <TagCard key="__tags" tags={topTags} />}
                      <p className="text-center text-xs pt-4 text-content-muted">
                        {eventList.length} event{eventList.length !== 1 ? 's' : ''}
                        {!q && category && category !== 'all' ? ` · ${category}` : ''}
                        {q ? ` · "${q}"` : ''}
                      </p>
                    </div>
                  )}
                </EventFeed>
              </>
            )}
          </main>
        </FiltersProvider>
      </Suspense>

    </div>
  )
}

function NoBoardsState() {
  return (
    <div className="text-center py-16">
      <p className="text-lg mb-2 font-marker text-content-primary">
        No boards yet
      </p>
      <p className="text-sm text-content-muted">
        Submit a photo to get your area started.
      </p>
      <Link
        href="/upload"
        className="text-sm mt-3 inline-block text-content-secondary underline underline-offset-2"
      >
        Submit a photo
      </Link>
    </div>
  )
}

function FallbackState() {
  return (
    <div className="text-center py-16">
      <p className="text-sm text-content-muted">
        ...
      </p>
    </div>
  )
}

function EmptyState({ category, q }: { category?: string; q?: string }) {
  return (
    <div className="text-center py-16">
      <p className="text-lg mb-2 font-marker text-content-primary">
        {q ? 'Searching the boards…' : 'No events found'}
      </p>
      <p className="text-sm text-content-muted">
        {q
          ? `Looking further for "${q}"…`
          : category && category !== 'all'
          ? `No ${category} events right now — try another category`
          : 'Nothing here yet — submit a photo to get started.'}
      </p>
      {category && category !== 'all' && !q ? (
        <Link
          href="/"
          className="text-sm mt-3 inline-block text-content-secondary underline underline-offset-2"
        >
          See all events
        </Link>
      ) : null}
    </div>
  )
}