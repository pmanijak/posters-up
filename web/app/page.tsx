// app/page.tsx
import { Suspense } from 'react'
import { createClient } from '@supabase/supabase-js'
import { FilterBar } from './components/filter-bar'
import { EventCard } from './components/event-card'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!
)

interface SearchParams {
  category?: string
}

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const { category } = await searchParams
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

  if (category && category !== 'all') {
    query = query.eq('event_category', category)
  }

  const { data: events, error } = await query
    .order('date_start', { ascending: true, nullsFirst: false })
    .limit(100)

  if (error) {
    console.error('events_public query failed:', error)
  }

  const eventList = events ?? []

  return (
    <div className="min-h-screen bg-surface-page">

      {/* Header */}
      <header className="border-b border-edge">
        <div className="max-w-2xl mx-auto px-4 py-6">
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

      {/* Filters */}
      <div className="sticky top-0 z-10 border-b border-edge bg-surface-page">
        <div className="max-w-2xl mx-auto px-4 py-3">
          <Suspense fallback={null}>
            <FilterBar activeCategory={category} />
          </Suspense>
        </div>
      </div>

      {/* Event list */}
      <main className="max-w-2xl mx-auto px-4 py-6">
        {eventList.length === 0 ? (
          <EmptyState category={category} />
        ) : (
          <div className="space-y-3">
            {eventList.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
            <p className="text-center text-xs pt-4 text-content-muted">
              {eventList.length} event{eventList.length !== 1 ? 's' : ''}
              {category && category !== 'all' ? ` · ${category}` : ''}
            </p>
          </div>
        )}
      </main>
    </div>
  )
}

function EmptyState({ category }: { category?: string }) {
  return (
    <div className="text-center py-16">
      <p className="text-lg mb-2 font-marker text-content-primary">
        No events found
      </p>
      <p className="text-sm text-content-muted">
        {category && category !== 'all'
          ? `No ${category} events coming up. Try a different category.`
          : 'Nothing here yet — submit a photo to get started.'}
      </p>
    </div>
  )
}