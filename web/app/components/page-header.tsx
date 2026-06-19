'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import type { CityOption } from './city-picker'

interface PageHeaderProps {
  cityLabel:  string | null
  cities:     CityOption[]
  isDetected: boolean
}

type DetectState = 'idle' | 'detecting' | 'error'

export function PageHeader({ cityLabel, cities, isDetected }: PageHeaderProps) {
  const [open, setOpen]               = useState(false)
  const [detectState, setDetectState] = useState<DetectState>('idle')
  const router = useRouter()

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeAndReset()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  function pick(lat: number, lng: number) {
    document.cookie = [
      `postersup_city=${lat.toFixed(4)},${lng.toFixed(4)}`,
      'max-age=2592000',
      'path=/',
      'SameSite=Lax',
      'Secure',
    ].join('; ')
    const params = new URLSearchParams()
    params.set('lat', lat.toFixed(4))
    params.set('lng', lng.toFixed(4))
    setOpen(false)
    router.push(`/?${params.toString()}`)
  }

  function closeAndReset() {
    setOpen(false)
    setDetectState('idle')
  }

  function pickCity(city: CityOption) {
    pick(city.lat, city.lng)
  }

  function detectLocation() {
    if (!navigator.geolocation) {
      setDetectState('error')
      return
    }
    setDetectState('detecting')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        pick(pos.coords.latitude, pos.coords.longitude)
      },
      () => {
        setDetectState('error')
      },

    )
  }

  const label = cityLabel ?? 'your area'

  return (
    <div>
      <header>
        <div className="max-w-2xl mx-auto px-4 pt-3">
          <div className="flex items-baseline justify-between">
            <div>
              <h1 className="font-marker text-3xl text-content-primary">
                Posters Up
              </h1>
              <div className="text-sm mt-0.5 text-content-muted">
                Events from the bulletin boards around{' '}
                <button
                  onClick={() => (open ? closeAndReset() : setOpen(true))}
                  className="inline-flex items-center gap-1.5 text-content-secondary hover:text-content-primary transition-colors"
                  aria-expanded={open}
                  aria-haspopup="dialog"
                >
                  <span className="underline underline-offset-2 decoration-dotted">{label}</span>
                  <span className={`text-content-muted inline-block transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▾</span>
                </button>
              </div>
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

      {/* City tray — in document flow, full page width, animates open with grid trick */}
      <div
        style={{
          display: 'grid',
          gridTemplateRows: open ? '1fr' : '0fr',
          transition: 'grid-template-rows 220ms ease',
        }}
      >
        <div style={{ overflow: 'hidden' }}>
          <div className="border-y border-edge mt-3">
            <div className="max-w-2xl mx-auto px-4 py-5 flex items-baseline gap-6">

              {/* Label */}
              <span className="font-mono text-xs text-content-muted shrink-0">
                {!cityLabel ? "We couldn't detect your city:" : 'Where are you?'}
              </span>

              {/* City names */}
              <div className="flex items-baseline flex-wrap gap-x-5 gap-y-2">
                {cities.map(city => (
                  <button
                    key={`${city.geo_city}-${city.geo_region}`}
                    onClick={() => pickCity(city)}
                    className="text-sm text-content-secondary hover:text-content-primary transition-colors"
                  >
                    {city.label}
                  </button>
                ))}
              </div>

              {/* Divider */}
              <span className="text-edge-subtle select-none shrink-0">·</span>

              {/* Browser geolocation */}
              <button
                onClick={detectLocation}
                disabled={detectState === 'detecting'}
                className="text-xs text-content-muted hover:text-content-secondary transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {detectState === 'detecting' ? 'Detecting…' : '📍 Use my location'}
              </button>

              {/* Error — shown inline, clears on next open */}
              {detectState === 'error' && (
                <span className="text-xs text-content-muted shrink-0">
                  Couldn't get your location.
                </span>
              )}

            </div>
          </div>
        </div>
      </div>
    </div>
  )
}