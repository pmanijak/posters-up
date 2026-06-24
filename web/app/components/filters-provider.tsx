'use client'
import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
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

  // Track the last q value we pushed ourselves so the sync effect can
  // distinguish "URL changed because user typed" from "URL changed because
  // of back/forward navigation." Without this, the server re-render that
  // follows a debounced push can overwrite the user's current input.
  const lastPushedQuery = useRef(initialQuery ?? '')

  // Only sync local state from URL on genuine external navigation
  // (back/forward), not on changes we triggered ourselves.
  useEffect(() => {
    const incoming = initialQuery ?? ''
    if (incoming !== lastPushedQuery.current) {
      setQuery(incoming)
      lastPushedQuery.current = incoming
    }
  }, [initialQuery])

  const pushParams = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, val] of Object.entries(updates)) {
      if (val === null || val === '') params.delete(key)
      else params.set(key, val)
    }
    // Record what we're about to push before navigating
    if ('q' in updates) {
      lastPushedQuery.current = updates.q ?? ''
    }
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [router, searchParams])

  return (
    <FiltersContext.Provider value={{ query, setQuery, pushParams }}>
      {children}
    </FiltersContext.Provider>
  )
}