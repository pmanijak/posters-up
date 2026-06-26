'use client'
import { useFilters } from './filters-provider'

export function EventFeed({ children }: { children: React.ReactNode }) {
  const { hasInterpretedResults } = useFilters()
  if (hasInterpretedResults) return null
  return <>{children}</>
}