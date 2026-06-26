'use client'
import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

type FiltersCtx = {
  query: string
  setQuery: (v: string) => void
  pushParams: (updates: Record<string, string | null>) => void
  hasInterpretedResults: boolean
  setHasInterpretedResults: (v: boolean) => void
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
  const [hasInterpretedResults, setHasInterpretedResults] = useState(false)
  const lastPushedQuery = useRef(initialQuery ?? '')

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
    if ('q' in updates) {
      lastPushedQuery.current = updates.q ?? ''
    }
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [router, searchParams])

  return (
    <FiltersContext.Provider value={{
      query, setQuery,
      pushParams,
      hasInterpretedResults, setHasInterpretedResults,
    }}>
      {children}
    </FiltersContext.Provider>
  )
}