import { createClient } from '@supabase/supabase-js'
import { resolveLocation } from '@/lib/location'
import { buildCityOptions } from '@/lib/cities'
import BoardsNearMe from './boards-near-me'
import type { CityOption } from '../components/city-picker'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!
)

export const metadata = { title: 'Boards — Posters Up' }

export default async function BoardsPage({
  searchParams,
}: {
  searchParams: Promise<{ lat?: string; lng?: string; board?: string }>
}) {
  // Read lat/lng from URL params (set by router.replace in boards-near-me
  // when the user picks a city, so the location survives a page refresh).
  // board param comes from event card "Map →" links — activates that board on load.
  const { lat: latParam, lng: lngParam, board: boardId } = await searchParams
  const { lat, lng } = await resolveLocation(latParam, lngParam)

  const [{ data: nearbyBoards }, { data: rawCities }] = await Promise.all([
    supabase.rpc('boards_near', { lat, lng }),
    supabase.rpc('available_cities'),
  ])

  const cityLabel: string | null = (nearbyBoards ?? [])[0]?.geo_city ?? null
  const cities: CityOption[]     = buildCityOptions(rawCities ?? [])

  return (
    <BoardsNearMe
      fallbackLat={lat}
      fallbackLng={lng}
      initialCityLabel={cityLabel}
      initialBoardId={boardId ?? null}
      cities={cities}
    />
  )
}