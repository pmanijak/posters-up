'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase'
import { categoryColor, hexToRgba } from '@/lib/categories'
import { seenAgo, staleness } from '@/lib/dates'
import { formatDistance } from '@/lib/format'
import { PageHeader } from '../components/page-header'
import { CityPicker } from '../components/city-picker'
import type { CityOption } from '../components/city-picker'

const BoardsMap = dynamic(() => import('./boards-map'), { ssr: false })

// ── Types ──────────────────────────────────────────────────────────────────

export interface BoardRow {
  id: string
  location_name: string | null
  description: string | null
  managed_by: string | null
  requires_entry_to_photograph: boolean | null
  requires_entry_to_post: boolean | null
  last_sighted_at: string
  active_flyer_count: number
  popular_tags: string[] | null
  primary_category: string | null
  // Distinct event_category values across active flyers on this board.
  // Requires content_categories column in boards_near_detail RPC — see migration.
  content_categories: string[] | null
  distance_m: number
  relevance_score: number
  board_lat: number
  board_lng: number
}

// 'granted'     = current location came from geolocation (shows "your location")
// 'denied'      = geo denied, or user picked a named city
// 'unavailable' = navigator.geolocation absent
// 'requesting'  = initial; resolves in the mount effect
type LocationState = 'requesting' | 'granted' | 'denied' | 'unavailable'

// ── Board card ─────────────────────────────────────────────────────────────

function BoardCard({
  board,
  active,
  showDistance,
  onClick,
}: {
  board: BoardRow
  active: boolean
  showDistance: boolean
  onClick: () => void
}) {
  const { fresh } = staleness(board.last_sighted_at)

  return (
    <div
      className={`rounded-sm overflow-hidden cursor-pointer transition-colors ${
        active ? 'bg-surface-raised' : 'bg-surface-card'
      }`}
      onClick={onClick}
    >
      <div className="px-4 py-3">

        {/* Name + distance — distance only shown when measured from user's GPS */}
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2
            className="font-bold leading-snug text-content-primary"
            style={{ fontFamily: 'Georgia, serif', fontSize: '1.05rem' }}
          >
            {board.location_name ?? board.managed_by ?? 'Unnamed board'}
          </h2>
          {showDistance && (
            <span className="text-xs font-mono text-content-muted shrink-0 tabular-nums pt-0.5">
              {formatDistance(board.distance_m)}
            </span>
          )}
        </div>

        {/* Navigation hint */}
        {board.description && (
          <p className="text-sm text-content-secondary leading-snug">
            {board.description}
          </p>
        )}

        {/* Tags — neutral pills; self-labeling text, color would be noise */}
        {board.popular_tags && board.popular_tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {board.popular_tags.map((tag) => (
              <span
                key={tag}
                className="text-xs px-2 py-0.5 rounded-full bg-surface-raised text-content-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between mt-2.5 pt-2.5 border-t border-edge">
          <div className="flex items-center gap-3 flex-wrap">

            {/* Category chips — colored because they describe real events on this board */}
            {board.content_categories && board.content_categories.length > 0 && (
              <div className="flex items-center gap-1">
                {board.content_categories.map((cat) => {
                  const color = categoryColor(cat)
                  return (
                    <span
                      key={cat}
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{ color, background: hexToRgba(color, 0.12) }}
                    >
                      {cat}
                    </span>
                  )
                })}
              </div>
            )}

            <span className="text-xs text-content-muted">
              {board.active_flyer_count}{' '}
              {board.active_flyer_count === 1 ? 'flyer' : 'flyers'}
            </span>
            <span className={`text-xs ${fresh ? 'text-content-accent' : 'text-content-muted'}`}>
              {seenAgo(board.last_sighted_at)}
            </span>
            {board.requires_entry_to_photograph && (
              <span className="text-xs text-content-muted">go inside</span>
            )}
          </div>
          {board.board_lat && board.board_lng && (
            <a
              href={`https://www.openstreetmap.org/?mlat=${board.board_lat}&mlon=${board.board_lng}#map=18/${board.board_lat}/${board.board_lng}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-content-muted hover:text-content-secondary transition-colors"
            >
              Map →
            </a>
          )}
        </div>

      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export default function BoardsNearMe({
  fallbackLat,
  fallbackLng,
  initialCityLabel,
  cities,
}: {
  fallbackLat:      number
  fallbackLng:      number
  initialCityLabel: string | null
  cities:           CityOption[]
}) {
  const router = useRouter()

  const [boards, setBoards]               = useState<BoardRow[]>([])
  const [loading, setLoading]             = useState(true)
  const [locationState, setLocationState] = useState<LocationState>('requesting')
  const [cityLabel, setCityLabel]         = useState<string | null>(initialCityLabel)
  const [mapCenter, setMapCenter]         = useState({ lat: fallbackLat, lng: fallbackLng })
  const [activeBoard, setActiveBoard]     = useState<string | null>(null)
  const [panToBoard, setPanToBoard]       = useState<string | null>(null)
  const [showMap, setShowMap]             = useState(false)
  const [mapReady, setMapReady]           = useState(false)
  // Unique per mount — forces a fresh DOM subtree for the map panel on each
  // page visit, preventing Leaflet's "container being reused" error.
  const [mapKey]                          = useState(() => Date.now())

  const listRef  = useRef<HTMLDivElement>(null)
  const supabase = createClient()

  // ── Data fetching ──────────────────────────────────────────────────────────

  async function fetchBoards(lat: number, lng: number) {
    setLoading(true)
    const { data, error } = await supabase.rpc('boards_near_detail', {
      lat,
      lng,
      radius_m: 10000,
    })
    if (!error && data) setBoards(data as BoardRow[])
    setLoading(false)
  }

  // On mount: use fallback coords, same as the events page.
  // Location is opt-in via "📍 Use my location" in the city picker — not requested automatically.
  useEffect(() => {
    setLocationState('denied')
    fetchBoards(fallbackLat, fallbackLng)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Mount the map only when it has a visible container to render into.
  useEffect(() => {
    if (window.matchMedia('(min-width: 768px)').matches) setMapReady(true)
  }, [])
  useEffect(() => {
    if (showMap) setMapReady(true)
  }, [showMap])

  // ── Location picking ───────────────────────────────────────────────────────

  // Called by PageHeader on city pick (label = city name) or geo detect (label = null).
  function handleCityPick(lat: number, lng: number, label: string | null) {
    // Shallow-update the URL so this location survives a page refresh.
    const params = new URLSearchParams()
    params.set('lat', lat.toFixed(4))
    params.set('lng', lng.toFixed(4))
    router.replace(`/boards?${params.toString()}`, { scroll: false })

    setCityLabel(label)
    setMapCenter({ lat, lng })
    setLocationState(label === null ? 'granted' : 'denied')
    fetchBoards(lat, lng)
  }

  // ── Map / list coordination ────────────────────────────────────────────────

  // Marker click: board is already visible, just highlight it.
  // Don't set panToBoard — that's what was causing the jump.
  function handleMarkerClick(id: string) {
    setActiveBoard(id)
    // No setShowMap — on mobile, marker click shows the popup in place.
    // scrollIntoView is a no-op when the list panel is hidden; useful on desktop.
    const el = listRef.current?.querySelector<HTMLElement>(`[data-board-id="${id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  // Card click: highlight and pan the map to show the board.
  function handleCardClick(id: string) {
    const newId = activeBoard === id ? null : id
    setActiveBoard(newId)
    setPanToBoard(newId)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col bg-surface-page" style={{ height: '100dvh' }}>

      <PageHeader
        cityLabel={cityLabel}
        cities={cities}
        isDetected={locationState === 'granted'}
        subtitle="Bulletin boards around"
        onCityPick={handleCityPick}
        rightSlot={
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="text-xs text-content-muted hover:text-content-secondary transition-colors"
            >
              ← Events
            </Link>
            <Link
              href="/upload"
              className="text-xs px-3 py-1.5 rounded border border-edge-subtle text-content-secondary transition-colors hover:border-edge"
            >
              Submit photo
            </Link>
          </div>
        }
      />

      {/* Mobile tab bar */}
      <div className="flex md:hidden border-b border-edge flex-shrink-0">
        {(['List', 'Map'] as const).map((tab) => {
          const active = tab === 'List' ? !showMap : showMap
          return (
            <button
              key={tab}
              onClick={() => setShowMap(tab === 'Map')}
              className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? 'text-content-primary border-b-2 border-brand'
                  : 'text-content-muted'
              }`}
            >
              {tab}
            </button>
          )
        })}
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">

        {/* List panel */}
        <div
          ref={listRef}
          className={`w-full md:w-[600px] md:flex-shrink-0 overflow-y-auto touch-pan-y ${
            showMap ? 'hidden md:block' : 'block'
          }`}
        >
          {loading ? (
            <p className="text-sm text-content-muted text-center py-20">Loading…</p>
          ) : boards.length === 0 ? (
            <CityPicker
              cities={cities}
              onPick={(city) => handleCityPick(city.lat, city.lng, city.label)}
            />
          ) : (
            <div className="p-3 space-y-3">
              {boards.map((board) => (
                <div key={board.id} data-board-id={board.id}>
                  <BoardCard
                    board={board}
                    active={activeBoard === board.id}
                    showDistance={locationState === 'granted'}
                    onClick={() => handleCardClick(board.id)}
                  />
                </div>
              ))}
              <p className="text-center text-xs pt-2 pb-4 text-content-muted">
                {boards.length} board{boards.length !== 1 ? 's' : ''}
              </p>
            </div>
          )}
        </div>

        {/* Map panel */}
        <div key={mapKey} className={`flex-1 min-w-0 ${showMap ? 'block' : 'hidden md:block'}`}>
          {mapReady && (
            <BoardsMap
              boards={boards}
              center={mapCenter}
              activeBoard={activeBoard}
              panToBoard={panToBoard}
              fitToBoards={locationState !== 'granted'}
              onBoardClick={handleMarkerClick}
              showUserDot={locationState === 'granted'}
            />
          )}
        </div>

      </div>
    </div>
  )
}