import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense, cache } from 'react'
import { createClient } from '@supabase/supabase-js'
import Link from 'next/link'
import { EventCard } from '@/app/components/event-card'
import { PageHeader } from '@/app/components/page-header'
import { SITE_TITLE, SITE_URL } from '@/lib/site'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!
)

// cache() deduplicates the fetch between generateMetadata and the page component
const getEvent = cache(async (id: string) => {
  const { data, error } = await supabase
    .from('events_public')
    .select('*')
    .eq('id', id)
    .single()
  if (error || !data) return null
  return data
})

function buildMetaDescription(event: any): string {
  const parts: string[] = []

  if (event.date_type === 'specific' && event.date_start) {
    const [y, m, d] = event.date_start.split('-').map(Number)
    const dateStr = new Date(y, m - 1, d).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
    })
    parts.push(dateStr.toUpperCase())
  } else if (event.date_raw) {
    parts.push(event.date_raw.toUpperCase())
  }

  const location = event.venue_name ?? event.location_name
  if (location) parts.push(location)

  if (event.talent?.length) {
    parts.push(event.talent.map((t: any) => t.name).join(', '))
  }

  const details: string[] = []
  if (event.price_raw)       details.push(event.price_raw)
  else if (event.is_free)    details.push('Free')
  if (event.age_restriction) details.push(event.age_restriction)
  if (details.length)        parts.push(details.join(' · '))

  return parts.join(' — ')
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const event = await getEvent(id)
  if (!event) return { title: SITE_TITLE }

  const title       = `${event.name} · ${SITE_TITLE}`
  const description = buildMetaDescription(event)
  const url         = `${SITE_URL}/events/${id}`

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url,
      siteName: SITE_TITLE,
      type:     'website',
      images:   [{ url: '/og.jpg', width: 1200, height: 630 }],
    },
    twitter: {
      card:        'summary_large_image',
      title,
      description,
      images:      ['/og.jpg'],
    },
  }
}

export default async function EventPage({
  params,
  searchParams,
}: {
  params:       Promise<{ id: string }>
  searchParams: Promise<{ ref?: string }>
}) {
  const { id }  = await params
  const { ref } = await searchParams

  const [event, boardResult] = await Promise.all([
    getEvent(id),
    supabase
      .from('event_board_locations')
      .select('location_name')
      .eq('event_id', id)
      .not('location_name', 'is', null)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (!event) notFound()

  const provenanceName = boardResult.data?.location_name ?? null
  const backHref       = ref === 'chat' ? '/chat' : '/'
  const backLabel      = ref === 'chat' ? '← Chat' : '← Events'

  const subtitle = provenanceName
    ? `Found on the bulletin board at ${provenanceName}`
    : undefined

  return (
    <div className="min-h-screen bg-surface-page">
      <PageHeader
        subtitle={subtitle}
        leftSlot={
          <Link
            href={backHref}
            className="text-sm text-content-muted hover:text-content-secondary transition-colors"
          >
            {backLabel}
          </Link>
        }
        rightSlot={
          <Link
            href="/upload"
            className="text-sm text-content-muted hover:text-content-secondary transition-colors whitespace-nowrap"
          >
            Submit photo
          </Link>
        }
      />
      <main className="max-w-2xl mx-auto px-4 py-4">
        <Suspense fallback={<div className="rounded-sm bg-surface-card h-40 animate-pulse" />}>
          <EventCard event={event} />
        </Suspense>
      </main>
    </div>
  )
}