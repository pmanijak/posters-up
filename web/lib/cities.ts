import type { CityOption } from '@/app/components/city-picker'

export function buildCityOptions(
  rows: { geo_city: string; geo_region: string | null; lat: number; lng: number }[]
): CityOption[] {
  const cityCounts = new Map<string, number>()
  for (const row of rows) {
    cityCounts.set(row.geo_city, (cityCounts.get(row.geo_city) ?? 0) + 1)
  }
  return rows.map(row => ({
    ...row,
    label:
      (cityCounts.get(row.geo_city) ?? 0) > 1 && row.geo_region
        ? `${row.geo_city}, ${row.geo_region}`
        : row.geo_city,
  }))
}