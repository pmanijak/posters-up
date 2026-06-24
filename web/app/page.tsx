import { Suspense } from 'react'
import { createClient } from '@supabase/supabase-js'
import { FiltersProvider } from './components/filters-provider'
import { FilterBar } from './components/filter-bar'
import { SearchInput } from './components/search-input'
import { EventCard } from './components/event-card'
import { CityPicker, type CityOption } from './components/city-picker'
import { PageHeader } from './components/page-header'
import { resolveLocation } from '@/lib/location'
import { buildCityOptions } from '@/lib/cities'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!
)

interface SearchParams {
  category?: string
  q?: string
  lat?: string
  lng?: string
}

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const { category, q, lat: latParam, lng: lngParam } = await searchParams

  const location = await resolveLocation(latParam, lngParam)
  const { lat, lng } = location

  const pacificTime = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
  })
  const today         = pacificTime.format(new Date(Date.now() - 3 * 60 * 60 * 1000))
  const thirtyDaysOut = pacificTime.format(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000))

  const { data: nearbyBoards } = await supabase.rpc('boards_near', { lat, lng })
  const nearbyBoardIds = (nearbyBoards ?? []).map((b: { id: string }) => b.id)
  const cityLabel      = (nearbyBoards ?? [])[0]?.geo_city ?? null

  const noBoardsNearby = nearbyBoardIds.length === 0

  const { data: rawCities } = await supabase.rpc('available_cities')
  const availableCities: CityOption[] = buildCityOptions(rawCities ?? [])

  let eventList: any[] = []

  if (!noBoardsNearby) {
    let query = supabase
      .rpc('events_for_boards', { board_ids: nearbyBoardIds })
      .or(
        `and(date_start.lte.${thirtyDaysOut},or(date_end.gte.${today},and(date_end.is.null,date_start.gte.${today}))),date_type.in.(recurring,approximate,unknown)`
      )

    if (category && category !== 'all' && !q) {
      query = query.eq('event_category', category)
    }

    if (q) {
      query = query.ilike('search_text', `%${q}%`)
    }

    const { data: events, error } = await query.limit(500)

    if (error) {
      console.error('events_public query failed:', error)
    }

    eventList = events ?? []
  }

  const DATE_TYPE_PRIORITY: Record<string, number> = {
    specific:    0,
    recurring:   1,
    approximate: 2,
    unknown:     3,
  }

  eventList = [...eventList].sort((a, b) => {
    const pa = DATE_TYPE_PRIORITY[a.date_type] ?? 3
    const pb = DATE_TYPE_PRIORITY[b.date_type] ?? 3
    if (pa !== pb) return pa - pb

    const sortKey = (e: any): string | null => {
      if (e.date_type !== 'specific') return null
      if (e.date_start > today) return e.date_start
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

  return (
    <div className="min-h-screen bg-surface-page">

      <PageHeader
        cityLabel={cityLabel}
        cities={availableCities}
        isDetected={location.source !== 'cookie'}
      />

      <Suspense fallback={null}>
        <FiltersProvider initialQuery={q}>

          <div className="sticky top-0 z-10 bg-surface-page">
            <div className="max-w-2xl mx-auto px-4 pt-2 pb-3">
              <FilterBar activeCategory={category} />
            </div>
          </div>

          <main className="max-w-2xl mx-auto px-4">
            <div className="my-3">
              <SearchInput />
            </div>

            {noBoardsNearby ? (
              availableCities.length > 0 ? (
                <CityPicker cities={availableCities} />
              ) : (
                <NoBoardsState />
              )
            ) : eventList.length === 0 ? (
              <EmptyState category={category} q={q} />
            ) : (
              <div className="space-y-3">
                {eventList.map((event) => (
                  <EventCard key={event.id} event={event} />
                ))}
                <p className="text-center text-xs pt-4 text-content-muted">
                  {eventList.length} event{eventList.length !== 1 ? 's' : ''}
                  {!q && category && category !== 'all' ? ` · ${category}` : ''}
                  {q ? ` · "${q}"` : ''}
                </p>
              </div>
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
      <a
        href="/upload"
        className="text-sm mt-3 inline-block text-content-secondary underline underline-offset-2"
      >
        Submit a photo
      </a>
    </div>
  )
}

function EmptyState({ category, q }: { category?: string; q?: string }) {
  return (
    <div className="text-center py-16">
      <p className="text-lg mb-2 font-marker text-content-primary">
        No events found
      </p>
      <p className="text-sm text-content-muted">
        {q
          ? `Nothing matching "${q}". Try different words or clear the search.`
          : category && category !== 'all'
          ? `No ${category} events coming up. Try a different category.`
          : 'Nothing here yet — submit a photo to get started.'}
      </p>
      {category && category !== 'all' && !q ? (
        <a
          href="/"
          className="text-sm mt-3 inline-block text-content-secondary underline underline-offset-2"
        >
          See all events
        </a>
      ) : null}
    </div>
  )
}