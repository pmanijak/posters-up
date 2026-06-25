// app/chat/page.tsx

import type { Metadata } from 'next'
import { createClient } from '@supabase/supabase-js'
import { SITE_TITLE, SITE_URL } from '@/lib/site'
import { buildCityOptions } from '@/lib/cities'
import { resolveLocation } from '@/lib/location'
import { ChatPageHeader } from './chat-page-header'
import { ChatInterface } from './chat-interface'

export const metadata: Metadata = {
  title:       `Chat · ${SITE_TITLE}`,
  description: "Chat with an AI that knows what's on the bulletin boards in Olympia, WA.",
  openGraph: {
    title:       `Ask about events · ${SITE_TITLE}`,
    description: "Chat with an AI that knows what's on the bulletin boards in Olympia, WA.",
    url:         `${SITE_URL}/chat`,
    siteName:    SITE_TITLE,
    type:        'website',
  },
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!
)

interface SearchParams {
  lat?: string
  lng?: string
}

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const { lat: latParam, lng: lngParam } = await searchParams
  const location = await resolveLocation(latParam, lngParam)

  const { data: rawCities } = await supabase.rpc('available_cities')
  const availableCities = buildCityOptions(rawCities ?? [])

  const { data: nearbyBoards } = await supabase.rpc('boards_near', {
    lat: location.lat,
    lng: location.lng,
  })
  const cityLabel = (nearbyBoards ?? [])[0]?.geo_city ?? null

  return (
    <div className="min-h-screen bg-surface-page flex flex-col">
      <ChatPageHeader cities={availableCities} cityLabel={cityLabel} />
      <ChatInterface />
    </div>
  )
}