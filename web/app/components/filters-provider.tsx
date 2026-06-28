'use client'
import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

export interface Group { label: string; event_ids: string[] }
export interface Payload { lead: string; groups: Group[]; events: Record<string, any> }

const pool = ['📌', '📌', '📌', '📋', '📌', '📌', '📋', '📌']
const pick = () => pool[Math.floor(Math.random() * pool.length)]

type FiltersCtx = {
  query: string
  setQuery: (v: string) => void
  pushParams: (updates: Record<string, string | null>) => void
  hasInterpretedResults: boolean
  setHasInterpretedResults: (v: boolean) => void

  // interpreted-search state, lifted out of SearchInput so results can render
  // in the feed surface while the input lives at the top of the page
  searchData: Payload | null
  searchStatus: 'idle' | 'loading' | 'error'
  pins: string
  runSearch: (q: string) => void
  clearResults: () => void
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

  const [searchData,   setSearchData]   = useState<Payload | null>(null)
  const [searchStatus, setSearchStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [pins,         setPins]         = useState('')
  const searchAbortRef = useRef<AbortController | null>(null)

  // Sync query from the SSR-provided initialQuery when it changes.
  useEffect(() => {
    const incoming = initialQuery ?? ''
    if (incoming !== lastPushedQuery.current) {
      setQuery(incoming)
      lastPushedQuery.current = incoming
    }
  }, [initialQuery])

  // When the URL query clears (non-empty → empty), drop interpreted results.
  // Keyed off initialQuery (the SSR re-render landing), not a timeout, to avoid
  // a flash of stale Claude results before the normal feed comes back.
  const prevInitialQuery = useRef(initialQuery ?? '')
  useEffect(() => {
    const incoming = initialQuery ?? ''
    if (prevInitialQuery.current !== '' && incoming === '') {
      clearResults()
    }
    prevInitialQuery.current = incoming
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

  function clearResults() {
    searchAbortRef.current?.abort()
    searchAbortRef.current = null
    setSearchData(null)
    setSearchStatus('idle')
    setPins('')
    setHasInterpretedResults(false)
  }

  // Defined inline (not useCallback) so it always closes over fresh state —
  // matches the original SearchInput behavior where re-renders recreated it.
  async function runSearch(q: string) {
    if (!q.trim() || searchStatus === 'loading') return
    setQuery(q)
    pushParams({ q, category: null })   // vibe search exits any category filter
    setSearchStatus('loading')

    // Cancel any prior in-flight search and track this one so clearResults()
    // (or a newer search) can abort it before its async resolution writes state.
    searchAbortRef.current?.abort()
    const controller = new AbortController()
    searchAbortRef.current = controller

    let count = 1
    setPins(pick())
    const id = setInterval(() => {
      count += 1
      if (count > 20) return
      setPins(p => p + ' ' + pick())
    }, 1000)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
        signal: controller.signal,
      })
      const payload = await res.json()
      clearInterval(id)
      if (controller.signal.aborted) return   // cleared mid-flight — drop the result
      setPins('')
      if (!res.ok || payload.error) { setSearchStatus('error'); return }
      setSearchData(payload)
      setHasInterpretedResults(true)
      setSearchStatus('idle')
    } catch (err) {
      clearInterval(id)
      if (controller.signal.aborted) return   // abort throws — swallow it silently
      setPins('')
      setSearchStatus('error')
    }
  }

  return (
    <FiltersContext.Provider value={{
      query, setQuery,
      pushParams,
      hasInterpretedResults, setHasInterpretedResults,
      searchData, searchStatus, pins,
      runSearch, clearResults,
    }}>
      {children}
    </FiltersContext.Provider>
  )
}