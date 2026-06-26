'use client'
// app/components/search-input.tsx
import { useRef, useState, useEffect } from 'react'
import { useFilters } from './filters-provider'
import { EventCard } from './event-card'

interface Group { label: string; event_ids: string[] }
interface Payload { lead: string; groups: Group[]; events: Record<string, any> }

const pool = ['📌', '📌', '📌', '📋', '📌', '📌', '📋', '📌']
const pick = () => pool[Math.floor(Math.random() * pool.length)]

export function SearchInput({ eventCount = 0, initialQuery = '' }: { eventCount?: number, initialQuery?: string }) {
  const { query, setQuery, pushParams, setHasInterpretedResults, setIsClearing } = useFilters()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [data,   setData]   = useState<Payload | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [pins,   setPins]   = useState('')

  // Auto-fire Claude when ilike comes up empty after 1 second of no typing.
  useEffect(() => {
    if (!query.trim() || eventCount > 0 || status === 'loading' || data) return
    const id = setTimeout(() => runSearch(query), 1000)
    return () => clearTimeout(id)
  }, [query, eventCount])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setQuery(val)
    if (data) { setData(null); setStatus('idle'); setHasInterpretedResults(false) }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      pushParams({ q: val || null })
    }, 300)
  }

  const prevInitialQueryRef = useRef(initialQuery)
  useEffect(() => {
    if (prevInitialQueryRef.current !== '' && initialQuery === '') {
      setData(null)
      setHasInterpretedResults(false)
    }
    prevInitialQueryRef.current = initialQuery
  }, [initialQuery, setHasInterpretedResults])

  const clearSearch = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setQuery('')
    pushParams({ q: null })
  }

  async function runSearch(q: string) {
    if (!q.trim() || status === 'loading') return
    setStatus('loading')
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
      })
      const payload = await res.json()
      clearInterval(id)
      setPins('')
      if (!res.ok || payload.error) { setStatus('error'); return }
      setData(payload)
      setHasInterpretedResults(true)
      setStatus('idle')
    } catch {
      clearInterval(id)
      setPins('')
      setStatus('error')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') runSearch(query)
  }

  const groupedIds = new Set((data?.groups ?? []).flatMap(g => g.event_ids))
  const leftovers  = data ? Object.keys(data.events).filter(id => !groupedIds.has(id)) : []

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
          disabled={status === 'loading' || !query.trim()}
          className="px-3 py-1.5 rounded text-sm bg-surface-raised border border-edge text-content-secondary disabled:opacity-40 transition-opacity whitespace-nowrap"
        >
          Search
        </button>
      </div>

      {/* Loader */}
      {status === 'loading' && (
        <p className="text-base tracking-widest" aria-label="Searching">
          {pins || '…'}
        </p>
      )}

      {/* Error */}
      {status === 'error' && (
        <p className="text-sm text-content-muted">Something went wrong. Try again.</p>
      )}

      {/* Interpreted results */}
      {data && status === 'idle' && (
        <div className="space-y-6">
          {Object.keys(data.events).length === 0 ? (
            <p className="text-sm text-content-muted">
              Nothing found for "{query}". New events appear as more boards are photographed.
            </p>
          ) : (
            <>
              {data.lead && (
                <p className="text-sm leading-relaxed text-content-secondary">{data.lead}</p>
              )}
              {data.groups.map(group => (
                <section key={group.label} className="space-y-3">
                  <h2 className="text-xs uppercase tracking-wider text-content-muted">
                    {group.label}
                  </h2>
                  {group.event_ids.map(id => (
                    <EventCard key={id} event={data.events[id]} />
                  ))}
                </section>
              ))}
              {leftovers.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-xs uppercase tracking-wider text-content-muted">
                    More events nearby
                  </h2>
                  {leftovers.map(id => (
                    <EventCard key={id} event={data.events[id]} />
                  ))}
                </section>
              )}
              <p className="text-center text-xs pt-4 text-content-muted">
                {Object.keys(data.events).length} events · "{query}"
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}