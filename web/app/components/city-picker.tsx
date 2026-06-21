'use client'

import { useRouter } from 'next/navigation'

export interface CityOption {
  geo_city:   string
  geo_region: string | null
  lat:        number
  lng:        number
  label:      string  // pre-computed by server: "Olympia" or "Olympia, Washington"
}

export function CityPicker({
  cities,
  onPick,
}: {
  cities: CityOption[]
  onPick?: (city: CityOption) => void
}) {
  const router = useRouter()

  function pick(city: CityOption) {
    // Always persist the choice — server reads this on next load so the
    // right city renders immediately with no flash. 30-day expiry.
    document.cookie = [
      `postersup_city=${city.lat.toFixed(4)},${city.lng.toFixed(4)}`,
      'max-age=2592000',
      'path=/',
      'SameSite=Lax',
      'Secure',
    ].join('; ')

    if (onPick) {
      onPick(city)
      return
    }

    const params = new URLSearchParams()
    params.set('lat', city.lat.toFixed(4))
    params.set('lng', city.lng.toFixed(4))
    router.push(`/?${params.toString()}`)
  }

  return (
    <div className="text-center py-12">
      <p className="text-lg mb-1 font-marker text-content-primary">
        Where are you?
      </p>
      <p className="text-sm text-content-muted mb-5">
        Pick a city to see what's on the boards.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {cities.map(city => (
          <button
            key={`${city.geo_city}-${city.geo_region}`}
            onClick={() => pick(city)}
            className="px-4 py-2 rounded border border-edge-subtle text-content-secondary text-sm transition-colors hover:border-edge hover:text-content-primary"
          >
            {city.label}
          </button>
        ))}
      </div>
      <div className="mt-10 pt-8 border-t border-edge-subtle">
        <p className="text-sm text-content-muted mb-3">
          Your city isn't here yet?
        </p>
        <a
          href="/upload"
          className="text-xs px-3 py-1.5 rounded border border-edge-subtle text-content-secondary transition-colors hover:border-edge"
        >
          Start it by taking a photo of a bulletin board
        </a>
      </div>
    </div>
  )
}