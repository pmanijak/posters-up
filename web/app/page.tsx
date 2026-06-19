// app/page.tsx
import { Suspense } from 'react'
import { headers, cookies } from 'next/headers'
import { createClient } from '@supabase/supabase-js'
import { FiltersProvider } from './components/filters-provider'
import { FilterBar } from './components/filter-bar'
import { SearchInput } from './components/search-input'
import { EventCard } from './components/event-card'
import { CityPicker, type CityOption } from './components/city-picker'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!
)

// Olympia, WA — default when no other location signal is available
const DEFAULT_LAT = 47.0379
const DEFAULT_LNG = -122.9007

interface SearchParams {
  category?: string
  q?: string
  lat?: string
  lng?: string
}

// Resolve a coordinate from: URL param → cookie → Vercel IP header → default.
// Cookie is an explicit user choice (set by CityPicker); it outranks IP detection
// because it represents intent, not inference.
function resolveCoord(
  urlParam: string | undefined,
  cookieVal: number | null,
  vercelHeader: string | null,
  defaultVal: number
): number {
  if (urlParam) return parseFloat(urlParam)
  if (cookieVal !== null && !isNaN(cookieVal)) return cookieVal
  if (vercelHeader) return parseFloat(vercelHeader)
  return defaultVal
}

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const { category, q, lat: latParam, lng: lngParam } = await searchParams

  // Read location signals
  const h = await headers()
  const cookieStore = await cookies()
  const savedLocation = cookieStore.get('postersup_city')?.value
  const [savedLat, savedLng] = savedLocation
    ? savedLocation.split(',').map(parseFloat)
    : [null, null]

  console.log('postersup_city cookie:', savedLocation)
  console.log('resolved lat/lng:', lat, lng)

  const lat = resolveCoord(latParam, savedLat, h.get('x-vercel-ip-latitude'),  DEFAULT_LAT)
  const lng = resolveCoord(lngParam, savedLng, h.get('x-vercel-ip-longitude'), DEFAULT_LNG)

  // Date cutoff: flip at 3am Pacific.
  // Subtract 3 hours so at 2:59am it's still "yesterday"; at 3:00am it rolls to today.
  const pacificTime = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
  })
  const today         = pacificTime.format(new Date(Date.now() - 3 * 60 * 60 * 1000))
  const thirtyDaysOut = pacificTime.format(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000))

  // Find nearby boards — gives us city name + event scope in one shot.
  // geo_city is populated by Nominatim during extraction.
  // The nearest board's city is always correct; Vercel IP city is not.
  const { data: nearbyBoards } = await supabase.rpc('boards_near', { lat, lng })
  const nearbyBoardIds = (nearbyBoards ?? []).map((b: { id: string }) => b.id)
  const cityLabel      = (nearbyBoards ?? [])[0]?.geo_city ?? null

  const noBoardsNearby = nearbyBoardIds.length === 0

  // Always fetch available cities — needed for the picker and costs almost nothing.
  // Duplicate city names (e.g. two "Springfield"s) get state appended automatically.
  const { data: rawCities } = await supabase.rpc('available_cities')
  const availableCities: CityOption[] = buildCityOptions(rawCities ?? [])

  let eventList: any[] = []

  if (!noBoardsNearby) {
    const { data: localFlyers } = await supabase
      .from('board_flyers')
      .select('event_id')
      .in('board_id', nearbyBoardIds)
      .eq('is_active', true)

    const localEventIds = (localFlyers ?? []).map((f: { event_id: string }) => f.event_id)

    if (localEventIds.length > 0) {
      let query = supabase
        .from('events_public')
        .select('*')
        .in('id', localEventIds)
        .or(
          `and(date_start.gte.${today},date_start.lte.${thirtyDaysOut}),date_type.in.(recurring,approximate,unknown)`
        )

      if (category && category !== 'all' && !q) {
        query = query.eq('event_category', category)
      }

      if (q) {
        query = query.ilike('search_text', `%${q}%`)
      }

      const { data: events, error } = await query.limit(100)

      if (error) {
        console.error('events_public query failed:', error)
      }

      eventList = events ?? []
    }
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
    if (!a.date_start && !b.date_start) return 0
    if (!a.date_start) return 1
    if (!b.date_start) return -1
    return a.date_start.localeCompare(b.date_start)
  })

  if (q && category && category !== 'all') {
    eventList = [
      ...eventList.filter(e => e.event_category === category),
      ...eventList.filter(e => e.event_category !== category),
    ]
  }

  return (
    <div className="min-h-screen bg-surface-page">

      <header>
        <div className="max-w-2xl mx-auto px-4 pt-3">
          <div className="flex items-baseline justify-between">
            <div>
              <h1 className="font-marker text-3xl text-content-primary">
                Posters Up
              </h1>
              <p className="text-sm mt-0.5 text-content-muted">
                Events from the bulletin boards{' '}
                {cityLabel ? `around ${cityLabel}` : 'near you'}
              </p>
            </div>
            <a
              href="/upload"
              className="text-xs px-3 py-1.5 rounded border border-edge-subtle text-content-secondary transition-colors hover:border-edge"
            >
              + Submit photo
            </a>
          </div>
        </div>
      </header>

      <Suspense fallback={null}>
        <FiltersProvider initialQuery={q}>

          <div className="sticky top-0 z-10 bg-surface-page">
            <div className="max-w-2xl mx-auto px-4 pt-6 pb-3">
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

// City name deduplication: only append state name when two cities share a name.
function buildCityOptions(
  rows: { geo_city: string; geo_region: string | null; lat: number; lng: number }[]
): CityOption[] {
  const cityCounts = new Map<string, number>()
  for (const row of rows) {
    cityCounts.set(row.geo_city, (cityCounts.get(row.geo_city) ?? 0) + 1)
  }

  return rows.map(row => ({
    ...row,
    label:
      (cityCounts.get(row.geo_city) ?? 0) > 1 && row.geo_region
        ? `${row.geo_city}, ${row.geo_region}`
        : row.geo_city,
  }))
}

// Shown only if the database has no cities at all (fresh deployment).
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