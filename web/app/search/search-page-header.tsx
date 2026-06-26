'use client'

// app/search/search-page-header.tsx
//
// Thin client wrapper around PageHeader for the search page.
// Overrides the default onCityPick navigation (which goes to /)
// to stay on /search with lat/lng as search params instead.

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { PageHeader } from '@/app/components/page-header'
import type { CityOption } from '@/app/components/city-picker'

export function SearchPageHeader({ cities, cityLabel }: { cities: CityOption[], cityLabel: string | null }) {
  const router = useRouter()

  return (
    <PageHeader
      leftSlot={
        <Link href="/" className="text-xs text-content-muted hover:text-content-secondary transition-colors">
          ← Events
        </Link>
      }
      subtitle="Search the posters around"
      cityLabel={cityLabel}
      cities={cities}
      isDetected={false}
      onCityPick={(lat, lng) => {
        const params = new URLSearchParams()
        params.set('lat', lat.toFixed(4))
        params.set('lng', lng.toFixed(4))
        router.push(`/search?${params.toString()}`)
      }}
    />
  )
}