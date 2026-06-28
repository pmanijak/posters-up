'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import type { Database } from '@/lib/database.generated'
import { createClient } from '@/lib/supabase'
import { categoryColor } from '@/lib/categories'
import { seenAgo, staleness } from '@/lib/dates'
import { formatDistance } from '@/lib/format'
import { hexToRgba } from '@/lib/utils/color'
import { PageHeader } from '../components/page-header'
import { CityPicker } from '../components/city-picker'
import type { CityOption } from '../components/city-picker'

const BoardsMap = dynamic(() => import('./boards-map'), { ssr: false })

// ── Types ──────────────────────────────────────────────────────────────────

// Base shape from generated types. Note: the generator omits | null on fields
// that are nullable in the underlying boards table — the null-coalescing in
// BoardCard is intentional and correct despite what the type says.
// content_categories was added in a later migration and isn't in the generated
// type yet; intersect it here until the next `supabase gen types` run.
type BoardRowBase = Database['public']['Functions']['boards_near_detail']['Returns'][number]

export type BoardRow = BoardRowBase & {
  // Distinct event_category values across active flyers on this board.
  // Requires content_categories column in boards_near_detail RPC — see migration.
  content_categories: string[] | null
}

// 'granted'     = current location came from geolocation (shows "your location")
// 'denied'      = geo denied, or user picked a named city
// 'unavailable' = navigator.geolocation absent
type LocationState = 'granted' | 'denied' | 'unavailable'

// Stable across renders — no component-level deps.
const supabase = createClient()

// ── Board card ─────────────────────────────────────────────────────────────

function BoardCard({
  board,
  active,
  showDistance,
  onClick,
  onMapClick,
}: {
  board: BoardRow
  active: boolean
  showDistance: boolean
  onClick: () => void
  onMapClick: () => void
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
              {board.active_flyer_count === 1 ? 'poster' : 'posters'}
            </span>
            <span className={`text-xs ${fresh ? 'text-content-accent' : 'text-content-muted'}`}>
              {seenAgo(board.last_sighted_at)}
            </span>
            {board.requires_entry_to_photograph && (
              <span className="text-xs text-content-muted">go inside</span>
            )}
          </div>
          {board.board_lat && board.board_lng && (
            <button
              onClick={(e) => { e.stopPropagation(); onMapClick() }}
              className="text-xs text-content-muted hover:text-content-secondary transition-colors"
            >
              Map →
            </button>
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
  initialBoardId,
  cities,
}: {
  fallbackLat:      number
  fallbackLng:      number
  initialCityLabel: string | null
  initialBoardId:   string | null
  cities:           CityOption[]
}) {
  const router = useRouter()

  const [boards, setBoards]               = useState<BoardRow[]>([])
  const [loading, setLoading]             = useState(true)
  const [locationState, setLocationState] = useState<LocationState>('denied')
  const [cityLabel, setCityLabel]         = useState<string | null>(initialCityLabel)
  const [mapCenter, setMapCenter]         = useState({ lat: fallbackLat, lng: fallbackLng })
  // If arriving from an event card "Map →" link, pre-activate that board
  // and show the map immediately (especially useful on mobile).
  const [activeBoard, setActiveBoard]     = useState<string | null>(initialBoardId)
  const [panToBoard, setPanToBoard]       = useState<string | null>(initialBoardId)
  const [showMap, setShowMap]             = useState(initialBoardId !== null)
  // Unique per mount — forces a fresh DOM subtree for the map panel on each
  // page visit, preventing Leaflet's "container being reused" error.
  const [mapKey]                          = useState(() => Date.now())
  // Checked once on mount; never changes. Avoids setState-in-effect patterns
  // that were previously used to gate map rendering.
  const [isDesktop]                       = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
  )

  const listRef = useRef<HTMLDivElement>(null)

  // ── Data fetching ──────────────────────────────────────────────────────────

  // Mount fetch — uses .then() so setState is in a callback, not in the
  // synchronous effect body. The linter flags any function containing setState
  // called synchronously in an effect, even if the setState itself is after
  // an await. Inlining with .then() is the approved pattern.
  useEffect(() => {
    let cancelled = false
    supabase
      .rpc('boards_near_detail', { lat: fallbackLat, lng: fallbackLng, radius_m: 10000 })
      .then(({ data, error }) => {
        if (cancelled) return
        if (!error && data) setBoards(data as BoardRow[])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [fallbackLat, fallbackLng])

  // Used only in handleCityPick (an event handler) where async setState is fine.
  async function fetchBoards(lat: number, lng: number) {
    const { data, error } = await supabase.rpc('boards_near_detail', {
      lat,
      lng,
      radius_m: 10000,
    })
    if (!error && data) setBoards(data as BoardRow[])
    setLoading(false)
  }

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
    setLoading(true)
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
        leftSlot={
          <Link
            href="/"
            className="text-xs text-content-muted hover:text-content-secondary transition-colors"
          >
            ← Events
          </Link>
        }
        rightSlot={
          <Link
            href="/upload"
            className="text-xs px-2 py-1 rounded border border-edge-subtle text-content-secondary transition-colors hover:border-edge whitespace-nowrap"
          >
            Submit photo
          </Link>
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
            <div className="px-3 pb-3 pt-0 space-y-3">
              {boards.map((board) => (
                <div key={board.id} data-board-id={board.id}>
                  <BoardCard
                    board={board}
                    active={activeBoard === board.id}
                    showDistance={locationState === 'granted'}
                    onClick={() => handleCardClick(board.id)}
                    onMapClick={() => {
                      setActiveBoard(board.id)
                      setPanToBoard(board.id)
                      setShowMap(true)
                    }}
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
          {(isDesktop || showMap) && (
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