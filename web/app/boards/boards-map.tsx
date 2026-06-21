'use client'

// Imported dynamically from boards-near-me — never rendered on the server.
// Requires: npm install leaflet react-leaflet && npm install -D @types/leaflet

import { useEffect, useLayoutEffect, useRef } from 'react'
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import type { BoardRow } from './boards-near-me'

// ----------------------------------------------------------------
// Pan / fit logic
// ----------------------------------------------------------------

function MapController({
  boards,
  panToBoard,
  fitToBoards,
}: {
  boards: BoardRow[]
  panToBoard: string | null
  fitToBoards: boolean
}) {
  const map = useMap()

  // Keep boards accessible in the panTo effect without making it a dependency
  // (avoids re-panning whenever boards are refetched).
  const boardsRef = useRef(boards)
  useEffect(() => { boardsRef.current = boards }, [boards])

  useEffect(() => {
    const container = map.getContainer()
    const observer = new ResizeObserver(() => map.invalidateSize())
    observer.observe(container)
    return () => observer.disconnect()
  }, [map])

  // Fit all boards in view when location isn't from GPS.
  // Re-runs on new fetches (city pick, initial load) — correct behavior.
  useEffect(() => {
    if (!fitToBoards || boards.length === 0) return
    const bounds = boards.map((b) => [b.board_lat, b.board_lng] as [number, number])
    map.fitBounds(bounds, { padding: [48, 48] })
  }, [boards, fitToBoards, map])

  // Only pan when a card in the list is clicked — not when a marker is clicked.
  useEffect(() => {
    if (!panToBoard) return
    const board = boardsRef.current.find((b) => b.id === panToBoard)
    if (board) map.panTo([board.board_lat, board.board_lng], { animate: true })
  }, [panToBoard, map])

  return null
}

// Radius scales with flyer count; capped so large boards don't
// overwhelm the map at higher zoom levels.
function markerRadius(count: number): number {
  return Math.min(7 + count * 0.8, 18)
}

// Theme values — matches globals.css tokens.
const BRAND    = '#7A9E82'  // --color-brand
const ACTIVE   = '#D4B86A'  // warm golden — visible against dark tiles
const USER_DOT = '#6fcf97'  // slightly brighter green for "you are here"

// ----------------------------------------------------------------
// Component
// ----------------------------------------------------------------

export default function BoardsMap({
  boards,
  center,
  activeBoard,
  panToBoard,
  fitToBoards,
  onBoardClick,
  showUserDot = false,
}: {
  boards: BoardRow[]
  center: { lat: number; lng: number }
  activeBoard: string | null
  // Separate from activeBoard — only set by card clicks in the list, not marker
  // clicks. Keeps the map from jumping when the user clicks a visible marker.
  panToBoard: string | null
  // True when the center is a city fallback rather than the user's GPS position.
  // MapController will fitBounds to show all boards instead of centering on center.
  fitToBoards: boolean
  onBoardClick: (id: string) => void
  showUserDot?: boolean
}) {
  // useLayoutEffect cleanup runs synchronously on unmount — important because
  // useEffect cleanup can lose the race with the next commit when navigating.
  // Clearing _leaflet_id prevents "Map container is being reused" on nav + back.
  const mapWrapperRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    // Capture the DOM node now — React nulls refs before cleanup fires,
    // so mapWrapperRef.current would be null if read inside the cleanup.
    const wrapper = mapWrapperRef.current
    return () => {
      const el = wrapper?.querySelector('.leaflet-container') as any
      if (el?._leaflet_id) delete el._leaflet_id
    }
  }, [])

  return (
    <div ref={mapWrapperRef} style={{ height: '100%', width: '100%' }}>
    <MapContainer
      center={[center.lat, center.lng]}
      zoom={14}
      style={{ height: '100%', width: '100%' }}
      className="z-0"
    >
      {/*
        CartoDB Dark Matter — free, no API key, matches the dark theme.
        Attribution required by their terms.
      */}
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        subdomains="abcd"
        maxZoom={20}
      />

      <MapController
        boards={boards}
        panToBoard={panToBoard}
        fitToBoards={fitToBoards}
      />

      {/* You-are-here dot — only when center is the user's actual GPS position */}
      {showUserDot && (
        <CircleMarker
          center={[center.lat, center.lng]}
          radius={6}
          pathOptions={{
            fillColor: USER_DOT,
            color: '#1E2420',  // --color-surface-page as ring
            weight: 2,
            fillOpacity: 1,
          }}
        />
      )}

      {/* Board markers */}
      {boards.map((board) => {
        const isActive = board.id === activeBoard
        return (
          <CircleMarker
            key={board.id}
            center={[board.board_lat, board.board_lng]}
            radius={markerRadius(board.active_flyer_count)}
            pathOptions={{
              fillColor: isActive ? ACTIVE : BRAND,
              color: '#1E2420',
              weight: isActive ? 2 : 1,
              fillOpacity: 0.9,
            }}
            eventHandlers={{ click: () => onBoardClick(board.id) }}
          >
            <Popup autoPan={false}>
              {/*
                Leaflet popups render outside the React tree and don't
                inherit CSS variables — use inline styles here.
              */}
              <div style={{ minWidth: 160, fontFamily: 'sans-serif' }}>
                <div style={{ fontWeight: 600, marginBottom: 2, color: '#1a1a1a' }}>
                  {board.location_name ?? 'Unnamed board'}
                </div>
                {board.description && (
                  <div style={{ fontSize: 12, color: '#555', marginBottom: 4, lineHeight: 1.4 }}>
                    {board.description}
                  </div>
                )}
                <div style={{ fontSize: 12, color: '#444' }}>
                  {board.active_flyer_count}{' '}
                  {board.active_flyer_count === 1 ? 'flyer' : 'flyers'} active
                </div>
                <a
                  href={`https://www.openstreetmap.org/?mlat=${board.board_lat}&mlon=${board.board_lng}&zoom=18`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 12, color: '#2563eb', display: 'block', marginTop: 6 }}
                >
                  Open in maps ↗
                </a>
              </div>
            </Popup>
          </CircleMarker>
        )
      })}
    </MapContainer>
    </div>
  )
}