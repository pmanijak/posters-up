'use client'
// app/components/search-input.tsx
import { useRef, useEffect } from 'react'
import { useFilters } from './filters-provider'
const SUGGESTIONS = [
"What's happening this weekend",
"Date night",
"Something chill",
"Inspiring for the kids",
]
export function SearchInput({ eventCount = 0 }: { eventCount?: number }) {
const {
query, setQuery, pushParams,
searchData, searchStatus,
runSearch, clearResults,
  } = useFilters()
const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
// Always points to the latest runSearch without being a dep.
// runSearch is intentionally not useCallback in FiltersProvider (closes over
// fresh searchStatus), so it's a new reference every render — adding it as
// a dep would re-fire the effect on every keystroke.
const runSearchRef = useRef(runSearch)
useEffect(() => {
runSearchRef.current = runSearch
  })
// Auto-fire Claude when ilike comes up empty after 1 second of no typing.
useEffect(() => {
if (!query.trim() || eventCount > 0 || searchStatus === 'loading' || searchData) return
const id = setTimeout(() => runSearchRef.current(query), 1000)
return () => clearTimeout(id)
  }, [query, eventCount, searchStatus, searchData])
const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
const val = e.target.value
setQuery(val)
// Any edit invalidates an active OR in-flight interpreted search — the query
// it ran for is now stale. clearResults() aborts the request so a late
// resolution can't pop results back in over the ilike filter.
if (searchData || searchStatus === 'loading') clearResults()
if (debounceRef.current) clearTimeout(debounceRef.current)
debounceRef.current = setTimeout(() => {
// interpreted: null clears the "this query was Claude-interpreted" flag —
// without this, editing an interpreted query into a new one that happens to
// still carry interpreted=1 from the stale URL would force an unwanted
// Claude call on text that was never actually interpreted. See FiltersProvider
// for where the flag gets set and read on mount.
pushParams({ q: val || null, interpreted: null })
    }, 300)
  }
const clearSearch = () => {
if (debounceRef.current) clearTimeout(debounceRef.current)
setQuery('')
pushParams({ q: null, interpreted: null })
  }
const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
if (e.key === 'Enter') runSearch(query)
  }
return (
<div className="space-y-1.5">
<div className="relative">
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
{/* Vibe examples — quiet caption hugging the input, not a control row.
          text-xs does the "helper text" job; color stays full content-muted
          (no opacity dimming) so the links read as tappable on the dark page.
          Plain underlined links signal "type something like this", distinct
          from the bordered category pills below. */}
{!query && !searchData && (
<p className="text-xs text-content-muted pl-3">
          try{' '}
{SUGGESTIONS.map((s, i) => (
<span key={s}>
<button
type="button"
onClick={() => runSearch(s)}
className="underline underline-offset-2 decoration-content-muted/60
                           hover:text-content-secondary hover:decoration-content-secondary
                           transition-colors"
>
{s}
</button>
{i < SUGGESTIONS.length - 1 ? ' · ' : ''}
</span>
          ))}
</p>
      )}
</div>
  )
}