'use client'
// app/components/search-input.tsx
import { useRef, useEffect } from 'react'
import { useFilters } from './filters-provider'

const SUGGESTIONS = [
  "What's happening this weekend?",
  "Nothing too loud",
  "Something inspiring for the kids?",
]

export function SearchInput({ eventCount = 0 }: { eventCount?: number }) {
  const {
    query, setQuery, pushParams,
    searchData, searchStatus,
    runSearch, clearResults,
  } = useFilters()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-fire Claude when ilike comes up empty after 1 second of no typing.
  useEffect(() => {
    if (!query.trim() || eventCount > 0 || searchStatus === 'loading' || searchData) return
    const id = setTimeout(() => runSearch(query), 1000)
    return () => clearTimeout(id)
  }, [query, eventCount])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setQuery(val)
    if (searchData) clearResults()
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      pushParams({ q: val || null })
    }, 300)
  }

  const clearSearch = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setQuery('')
    clearResults()
    pushParams({ q: null })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') runSearch(query)
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <label htmlFor="event-search" className="sr-only">Search events</label>
          <input
            id="event-search"
            type="text"
            value={query}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Search events…"
            className="w-full px-3 py-1.5 rounded text-sm bg-transparent outline-none placeholder:text-content-muted"
            style={{
              border: '1px solid var(--color-edge-subtle)',
              color: 'var(--color-content-primary)',
            }}
          />
          {query && (
            <button
              onClick={clearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-content-muted hover:text-content-secondary transition-colors"
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>
        <button
          onClick={() => runSearch(query)}
          disabled={searchStatus === 'loading' || !query.trim()}
          className="px-3 py-1.5 rounded text-sm bg-surface-raised border border-edge text-content-secondary disabled:opacity-40 transition-opacity whitespace-nowrap"
        >
          Search
        </button>
      </div>

      {/* Suggestion chips — visible when box is empty and no results showing */}
      {!query && !searchData && (
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map(s => (
            <button
              key={s}
              type="button"
              onClick={() => runSearch(s)}
              className="text-sm px-3 py-1.5 rounded-sm bg-surface-card border border-edge
                         text-content-muted hover:text-content-secondary transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}