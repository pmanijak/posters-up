'use client'
import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { Group, EventRow } from '@/lib/types/events'

export interface Payload {
  lead:   string
  groups: Group[]
  events: Record<string, EventRow>
}

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
  city = 'Olympia, WA',
  nearbyBoardIds = [],
  children,
}: {
  initialQuery?: string
  city?: string
  nearbyBoardIds?: string[]
  children: React.ReactNode
}) {  const router = useRouter()
  const searchParams = useSearchParams()
  const [query, setQuery] = useState(initialQuery ?? '')
  const [hasInterpretedResults, setHasInterpretedResults] = useState(false)
  const lastPushedQuery = useRef(initialQuery ?? '')

  const [searchData,   setSearchData]   = useState<Payload | null>(null)
  const [searchStatus, setSearchStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [pins,         setPins]         = useState('')
  const searchAbortRef = useRef<AbortController | null>(null)

  // pushParams reads from this ref rather than closing over `searchParams`
  // directly. runSearch is a plain async function, not useCallback — each call
  // captures whichever `pushParams` existed at invocation time and keeps using
  // it for the whole async lifetime, including the pushParams call that fires
  // after the fetch resolves. If pushParams closed over `searchParams` by
  // value, that second call would rebuild the URL from a stale pre-search
  // snapshot (missing the `q` the first pushParams call just added) and
  // clobber it. Reading through a ref that's kept current on every render
  // means every pushParams call — no matter how stale its own closure — always
  // merges onto the real current URL.
  const searchParamsRef = useRef(searchParams)
  useEffect(() => {
    searchParamsRef.current = searchParams
  }, [searchParams])

  // Sync query from the SSR-provided initialQuery when it changes.
  useEffect(() => {
    const incoming = initialQuery ?? ''
    if (incoming !== lastPushedQuery.current) {
      setQuery(incoming)
      lastPushedQuery.current = incoming
    }
  }, [initialQuery])

  const clearResults = useCallback(() => {
    searchAbortRef.current?.abort()
    searchAbortRef.current = null
    setSearchData(null)
    setSearchStatus('idle')
    setPins('')
    setHasInterpretedResults(false)
  }, [])

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
  }, [initialQuery, clearResults])

  const pushParams = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParamsRef.current.toString())
    for (const [key, val] of Object.entries(updates)) {
      if (val === null || val === '') params.delete(key)
      else params.set(key, val)
    }
    if ('q' in updates) {
      lastPushedQuery.current = updates.q ?? ''
    }
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [router])

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
      const res = await fetch('/api/chat-v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, city, boardIds: nearbyBoardIds }),
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
      // Mark this query as Claude-interpreted in the URL so a refresh knows to
      // re-run it directly rather than relying on SearchInput's eventCount===0
      // heuristic — that heuristic can't tell "never explicitly searched" apart
      // from "this exact query was interpreted last time, but also happens to
      // match the plain ilike filter." An explicit Enter-press or suggestion-chip
      // click bypasses the heuristic entirely, so without this flag a refresh
      // can silently fall back to worse, ungrouped results with no visible error.
      pushParams({ interpreted: '1' })
    } catch {
      clearInterval(id)
      if (controller.signal.aborted) return   // abort throws — swallow it silently
      setPins('')
      setSearchStatus('error')
    }
  }

  // Runs once on mount. If the URL says this query was previously served by
  // Claude, force it to run again immediately rather than waiting on
  // SearchInput's debounced eventCount heuristic — see the comment in runSearch
  // above for why the heuristic alone isn't a reliable signal on its own.
  const hasCheckedInterpretedOnMount = useRef(false)
  useEffect(() => {
    if (hasCheckedInterpretedOnMount.current) return
    hasCheckedInterpretedOnMount.current = true
    if (searchParams.get('interpreted') === '1' && initialQuery) {
      // runSearch calls setState synchronously before its first await
      // (setQuery, pushParams, setSearchStatus) — deferring with setTimeout(0)
      // moves that out of the effect body itself so it runs as its own task
      // rather than cascading synchronously off this effect.
      setTimeout(() => runSearch(initialQuery), 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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