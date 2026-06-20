import { cookies, headers } from 'next/headers'
import { CITY_COOKIE } from '@/lib/constants'

// Olympia, WA — default when no other location signal is available.
const DEFAULT_LAT = 47.0379
const DEFAULT_LNG = -122.9007


export type LocationSource = 'cookie' | 'ip' | 'default'

export interface ResolvedLocation {
  lat: number
  lng: number
  source: LocationSource
}

function resolveCoord(
  urlParam:      string | undefined,
  cookieVal:     number | null,
  vercelHeader:  string | null,
  fallback:      number,
): number {
  if (urlParam)                              return parseFloat(urlParam)
  if (cookieVal !== null && !isNaN(cookieVal)) return cookieVal
  if (vercelHeader)                          return parseFloat(vercelHeader)
  return fallback
}

export async function resolveLocation(
  urlLat?: string,
  urlLng?: string,
): Promise<ResolvedLocation> {
  const [cookieStore, h] = await Promise.all([cookies(), headers()])

  const saved = cookieStore.get(CITY_COOKIE)?.value
  const [savedLat, savedLng] = saved
    ? saved.split(',').map(parseFloat)
    : [null, null]

  const ipLat = h.get('x-vercel-ip-latitude')
  const ipLng = h.get('x-vercel-ip-longitude')

  // Source is determined by what's available, independent of whether
  // URL params overrode the final coords.
  const source: LocationSource =
    saved != null  ? 'cookie' :
    ipLat !== null ? 'ip'     :
                     'default'

  return {
    lat: resolveCoord(urlLat, savedLat, ipLat, DEFAULT_LAT),
    lng: resolveCoord(urlLng, savedLng, ipLng, DEFAULT_LNG),
    source,
  }
}