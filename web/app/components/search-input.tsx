'use client'
// app/components/search-input.tsx
import { useRef } from 'react'
import { useFilters } from './filters-provider'

export function SearchInput() {
  const { query, setQuery, pushParams } = useFilters()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      pushParams({ q: val || null })
    }, 300)
  }

  const clearSearch = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setQuery('')
    pushParams({ q: null })
  }

  return (
    <div className="relative">
      <label htmlFor="event-search" className="sr-only">
        Search events
      </label>
      <input
        id="event-search"
        type="text"
        value={query}
        onChange={handleChange}
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
  )
}