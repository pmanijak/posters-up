// app/page.tsx
import { Suspense } from 'react'
import { createClient } from '@supabase/supabase-js'
import { FiltersProvider } from './components/filters-provider'
import { FilterBar } from './components/filter-bar'
import { SearchInput } from './components/search-input'
import { EventCard } from './components/event-card'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!
)

interface SearchParams {
  category?: string
  q?: string
}

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const { category, q } = await searchParams
  const today = new Date().toISOString().split('T')[0]
  const thirtyDaysOut = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0]

  let query = supabase
    .from('events_public')
    .select('*')
    .or(
      `and(date_start.gte.${today},date_start.lte.${thirtyDaysOut}),date_type.in.(recurring,approximate,unknown)`
    )

  // When search is active, category becomes a priority sort rather than a hard filter.
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

  let eventList = events ?? []

  const DATE_TYPE_PRIORITY: Record<string, number> = {
    specific:    0,
    recurring:   1,
    approximate: 2,
    unknown:     3,
  }

  // Sort: specific upcoming events first by date, then recurring, approximate, unknown
  eventList = [...eventList].sort((a, b) => {
    const pa = DATE_TYPE_PRIORITY[a.date_type] ?? 3
    const pb = DATE_TYPE_PRIORITY[b.date_type] ?? 3
    if (pa !== pb) return pa - pb
    if (!a.date_start && !b.date_start) return 0
    if (!a.date_start) return 1
    if (!b.date_start) return -1
    return a.date_start.localeCompare(b.date_start)
  })

  // Category priority sort when search is active (replaces the filter block below)
  if (q && category && category !== 'all') {
    eventList = [
      ...eventList.filter(e => e.event_category === category),
      ...eventList.filter(e => e.event_category !== category),
    ]
  }

  return (
    <div className="min-h-screen bg-surface-page">

      {/* Header */}
      <header>
        <div className="max-w-2xl mx-auto px-4 pt-3">
          <div className="flex items-baseline justify-between">
            <div>
              <h1 className="font-marker text-3xl text-content-primary">
                Posters Up
              </h1>
              <p className="text-sm mt-0.5 text-content-muted">
                Events from the bulletin boards around Olympia
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

      {/*
        FiltersProvider owns query state and all URL writes.
        One Suspense boundary covers both FilterBar and SearchInput
        since useSearchParams() now only lives in the provider.
      */}
      <Suspense fallback={null}>
        <FiltersProvider initialQuery={q}>

          {/* Category chips — sticky */}
          <div className="sticky top-0 z-10 bg-surface-page">
            <div className="max-w-2xl mx-auto px-4 pt-6 pb-3">
              <FilterBar activeCategory={category} />
            </div>
          </div>

          {/* Event list */}
          <main className="max-w-2xl mx-auto px-4">
            {/* Search — sits right above the events */}
            <div className="my-3">
              <SearchInput />
            </div>

            {eventList.length === 0 ? (
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