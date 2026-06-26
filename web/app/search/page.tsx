// app/search/page.tsx

import type { Metadata } from 'next'
import { createClient } from '@supabase/supabase-js'
import { SITE_TITLE, SITE_URL } from '@/lib/site'
import { buildCityOptions } from '@/lib/cities'
import { resolveLocation } from '@/lib/location'
import { SearchPageHeader } from './search-page-header'
import { SearchInterface } from './search-interface'

export const metadata: Metadata = {
  title:       `Search · ${SITE_TITLE}`,
  description: "Search the posters around town.",
  openGraph: {
    title:       `Search · ${SITE_TITLE}`,
    description: "Search the posters around town.",
    url:         `${SITE_URL}/search`,
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

export default async function SearchPage({
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
    <div className="h-dvh bg-surface-page flex flex-col">
      <SearchPageHeader cities={availableCities} cityLabel={cityLabel} />
      <SearchInterface />
    </div>
  )
}