'use client'

// Imported dynamically from boards-near-me — never rendered on the server.
// Requires: npm install leaflet react-leaflet && npm install -D @types/leaflet

import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { MapContainer, TileLayer, CircleMarker, Marker, Popup, useMap } from 'react-leaflet'
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

  // ResizeObserver keeps the map sized correctly when the container changes.
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

// ----------------------------------------------------------------
// Thumbtack marker
// Circular head scales with flyer count; stem anchors at pin tip.
// Active pin: warm gold + drop shadow to lift it above the others.
// ----------------------------------------------------------------

// Theme values — matches globals.css tokens.
const BRAND    = '#7A9E82'  // --color-brand
const ACTIVE   = '#D4B86A'  // warm golden — visible against dark tiles
const USER_DOT = '#6fcf97'  // slightly brighter green for "you are here"
const DARK     = '#1E2420'  // --color-surface-page, used for strokes

function thumbtackIcon(flyerCount: number, active: boolean): L.DivIcon {
  const headR  = Math.round(Math.min(7 + flyerCount * 0.5, 12))
  const stroke = active ? 2 : 1.5
  const w      = headR * 2 + Math.ceil(stroke) * 2 + 2  // head diameter + stroke room
  const cx     = w / 2
  const headCy = headR + Math.ceil(stroke)               // center of head circle
  const stemY1 = headCy + headR                          // bottom of head
  const stemY2 = stemY1 + 11                             // tip of pin
  const h      = stemY2 + 1
  const color  = active ? ACTIVE : BRAND

  // Drop shadow on active pin lifts it visually without changing shape
  const defs = active
    ? `<defs><filter id="ps" x="-40%" y="-40%" width="180%" height="180%">
        <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="rgba(0,0,0,0.55)"/>
      </filter></defs>`
    : ''
  const filter = active ? ' filter="url(#ps)"' : ''

  const svg =
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
      ${defs}
      <g${filter}>
        <circle cx="${cx}" cy="${headCy}" r="${headR}"
          fill="${color}" stroke="${DARK}" stroke-width="${stroke}"/>
        <line x1="${cx}" y1="${stemY1}" x2="${cx}" y2="${stemY2}"
          stroke="${color}" stroke-width="2" stroke-linecap="round"/>
      </g>
    </svg>`

  return L.divIcon({
    html: svg,
    className: '',          // suppress leaflet-div-icon default white box + border
    iconSize:    [w, h],
    iconAnchor:  [cx, h],   // anchor at pin tip so it points to the board location
    popupAnchor: [0, -(h + 4)],
  })
}

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
  return (
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
            color: DARK,
            weight: 2,
            fillOpacity: 1,
          }}
        />
      )}

      {/* Board markers — thumbtack pins, active pin renders last (on top) */}
      {[...boards]
        .sort((a, b) => (b.id === activeBoard ? -1 : a.id === activeBoard ? 1 : 0))
        .map((board) => {
          const isActive = board.id === activeBoard
          return (
            <Marker
              key={board.id}
              position={[board.board_lat, board.board_lng]}
              icon={thumbtackIcon(board.active_flyer_count, isActive)}
              eventHandlers={{ click: () => onBoardClick(board.id) }}
              zIndexOffset={isActive ? 1000 : 0}
            >
              <Popup autoPan={false}>
                {/*
                  Leaflet popups render outside the React tree and don't
                  inherit CSS variables — use inline styles here.
                */}
                <div style={{ minWidth: 160, fontFamily: 'sans-serif' }}>
                  <div style={{ fontWeight: 600, marginBottom: 2, color: '#1a1a1a' }}>
                    {board.location_name ?? board.managed_by ?? 'Unnamed board'}
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
            </Marker>
          )
        })}
    </MapContainer>
  )
}