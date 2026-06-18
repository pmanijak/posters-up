'use client'
import { createContext, useContext, useState, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

type FiltersCtx = {
  query: string
  setQuery: (v: string) => void
  pushParams: (updates: Record<string, string | null>) => void
}

const FiltersContext = createContext<FiltersCtx | null>(null)

export function useFilters() {
  const ctx = useContext(FiltersContext)
  if (!ctx) throw new Error('useFilters outside FiltersProvider')
  return ctx
}

export function FiltersProvider({
  initialQuery,
  children,
}: {
  initialQuery?: string
  children: React.ReactNode
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [query, setQuery] = useState(initialQuery ?? '')

  const pushParams = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, val] of Object.entries(updates)) {
      if (val === null || val === '') params.delete(key)
      else params.set(key, val)
    }
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [router, searchParams])

  return (
    <FiltersContext.Provider value={{ query, setQuery, pushParams }}>
      {children}
    </FiltersContext.Provider>
  )
}