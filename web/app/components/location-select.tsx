'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import type { CityOption } from './city-picker'

interface LocationSelectProps {
  cityLabel:  string | null
  cities:     CityOption[]
  isDetected: boolean
}

export function LocationSelect({ cityLabel, cities }: LocationSelectProps) {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  function pick(city: CityOption) {
    document.cookie = [
      `postersup_city=${city.lat.toFixed(4)},${city.lng.toFixed(4)}`,
      'max-age=2592000',
      'path=/',
      'SameSite=Lax',
      'Secure',
    ].join('; ')
    const params = new URLSearchParams()
    params.set('lat', city.lat.toFixed(4))
    params.set('lng', city.lng.toFixed(4))
    setOpen(false)
    router.push(`/?${params.toString()}`)
  }

  const label = cityLabel ?? 'your area'

  return (
    <>
      <button
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-0.5 text-content-secondary hover:text-content-primary transition-colors"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="underline underline-offset-2 decoration-dotted">{label}</span>
        <span className={`text-content-muted inline-block transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          <div className="fixed left-1/2 -translate-x-1/2 top-20 z-50 w-64 rounded-xl border border-edge-subtle bg-surface-card shadow-xl py-5">

            {!cityLabel && (
              <p className="text-xs text-content-muted text-center mb-4 px-5">
                We couldn't detect your city.
              </p>
            )}

            {/* City names — plain, centered, no button chrome */}
            <div className="flex flex-col items-center gap-3">
              {cities.map(city => (
                <button
                  key={`${city.geo_city}-${city.geo_region}`}
                  onClick={() => pick(city)}
                  className="text-sm text-content-secondary hover:text-content-primary transition-colors"
                >
                  {city.label}
                </button>
              ))}
            </div>

            <div className="mt-5 pt-4 border-t border-edge-subtle flex justify-center">
              {/* TODO: wire up navigator.geolocation, then set cookie + navigate same as pick() */}
              <button
                disabled
                className="text-xs text-content-muted opacity-40 cursor-not-allowed"
              >
                Use my location
              </button>
            </div>

          </div>
        </>
      )}
    </>
  )
}