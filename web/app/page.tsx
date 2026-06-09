// app/page.tsx
// Move your existing upload form to app/upload/page.tsx if it lives here.
// This becomes the home page — discovery is the primary use of the app.

import { Suspense } from 'react'
import { createClient } from '@supabase/supabase-js'
import { FilterBar } from './components/filter-bar'
import { EventCard } from './components/event-card'

// Public page — anon key is fine, no auth needed.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!
)

interface SearchParams {
  category?: string
  when?: string
}

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const { category, when } = await searchParams
  const today = new Date().toISOString().split('T')[0]

  let query = supabase
    .from('events_public')
    .select('*')

  // Date filter
  if (when === 'upcoming') {
    // Upcoming specific events + all recurring/approximate/unknown
    query = query.or(
      `date_start.gte.${today},date_type.in.(recurring,approximate,unknown)`
    )
  } else if (when === 'week') {
    const weekLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]
    query = query.or(
      `and(date_start.gte.${today},date_start.lte.${weekLater}),date_type.in.(recurring,approximate,unknown)`
    )
  }
  // when === 'all': no date filter

  // Category filter
  if (category && category !== 'all') {
    query = query.eq('event_category', category)
  }

  // Specific dates first (ascending), undated events at the end
  const { data: events, error } = await query
    .order('date_start', { ascending: true, nullsFirst: false })
    .limit(100)

  if (error) {
    console.error('events_public query failed:', error)
  }

  const eventList = events ?? []

  return (
    <div className="min-h-screen" style={{ background: '#F7F3EE' }}>

      {/* Header */}
      <header className="border-b" style={{ borderColor: '#E0D8CE' }}>
        <div className="max-w-2xl mx-auto px-4 py-6">
          <div className="flex items-baseline justify-between">
            <div>
              <h1
                className="text-2xl font-bold tracking-widest uppercase"
                style={{ fontFamily: 'Georgia, serif', color: '#B94A1F', letterSpacing: '0.15em' }}
              >
                Posters Up
              </h1>
              <p className="text-sm mt-0.5" style={{ color: '#8A7E72' }}>
                Events from the bulletin boards around Olympia
              </p>
            </div>
            <a
              href="/upload"
              className="text-xs px-3 py-1.5 rounded border transition-colors"
              style={{ borderColor: '#E0D8CE', color: '#8A7E72' }}
            >
              + Submit photo
            </a>
          </div>
        </div>
      </header>

      {/* Filters — client component */}
      <div
        className="sticky top-0 z-10 border-b"
        style={{ background: '#F7F3EE', borderColor: '#E0D8CE' }}
      >
        <div className="max-w-2xl mx-auto px-4 py-3">
          <Suspense fallback={null}>
            <FilterBar activeCategory={category} activeWhen={when} />
          </Suspense>
        </div>
      </div>

      {/* Event list */}
      <main className="max-w-2xl mx-auto px-4 py-6">
        {eventList.length === 0 ? (
          <EmptyState when={when} category={category} />
        ) : (
          <div className="space-y-3">
            {eventList.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
            <p className="text-center text-xs pt-4" style={{ color: '#8A7E72' }}>
              {eventList.length} event{eventList.length !== 1 ? 's' : ''}
              {category && category !== 'all' ? ` · ${category}` : ''}
            </p>
          </div>
        )}
      </main>
    </div>
  )
}

function EmptyState({
  when,
  category,
}: {
  when: string
  category?: string
}) {
  return (
    <div className="text-center py-16">
      <p className="text-lg mb-2" style={{ fontFamily: 'Georgia, serif', color: '#1C1713' }}>
        No events found
      </p>
      <p className="text-sm" style={{ color: '#8A7E72' }}>
        {category && category !== 'all'
          ? `No ${category} events ${when === 'week' ? 'this week' : 'coming up'}. Try a different category.`
          : 'Nothing here yet — submit a photo to get started.'}
      </p>
    </div>
  )
}