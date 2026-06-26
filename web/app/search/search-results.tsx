'use client'

// app/search/search-results.tsx
//
// Directed-seeking surface. Type a phrase → the route interprets it and returns
// an orienting line + plain-language groups + full card rows. We render the real
// EventCards under each group, then any leftovers under "More events nearby".
//
// No chat thread, no streaming, no assistant prose — the lead line orients, the
// cards tell the truth. Last result persisted to sessionStorage so tapping into
// an event and coming back restores the view.

import { useState, useEffect } from 'react'
import { EventCard } from '@/app/components/event-card'

interface Group { label: string; event_ids: string[] }
interface Payload { lead: string; groups: Group[]; events: Record<string, any> }

const STORAGE_KEY = 'search-result'

const SUGGESTIONS = [
  'What\'s happening this weekend?',
  'Something to do tonight',
  'Free and outdoors',
  'Take the kids somewhere',
  'Low-key, nothing loud',
  'Surprise me',
]

export function SearchResults() {
  const [input,   setInput]   = useState('')
  const [query,   setQuery]   = useState('')        // the query that produced `data`
  const [data,    setData]    = useState<Payload | null>(null)
  const [status,  setStatus]  = useState<'idle' | 'loading' | 'error'>('idle')
  const [pins,    setPins]    = useState('')

  // Restore last result on mount
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY)
      if (saved) {
        const { query: q, data: d } = JSON.parse(saved)
        setQuery(q); setData(d)
      }
    } catch {}
  }, [])

  // Accumulate board-y emojis while a search is in flight. Time-based, not real
  // progress (the route doesn't stream — it returns one JSON payload at the end).
  // Weighted toward pushpins since they read most as "posted on a board"; the
  // occasional clipboard is mild variety. The render shows '…' until the first
  // pin lands at ~400ms, covering the gap so the screen never looks empty/broken.
  useEffect(() => {
    if (status !== 'loading') { setPins(''); return }
    const pool = ['📌', '📌', '📌', '📋', '📌', '📌', '📋', '📌']
    const pick = () => pool[Math.floor(Math.random() * pool.length)]
    let count = 1
    setPins(pick())
    const id = setInterval(() => {
      count += 1
      if (count > 20) return            // cap by emoji count, not string length
      setPins(p => p + ' ' + pick())
    }, 1000)
    return () => clearInterval(id)
  }, [status])

  async function run(text: string) {
    const q = text.trim()
    if (!q || status === 'loading') return
    setStatus('loading'); setQuery(q); setInput('')
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      })
      const payload = await res.json()
      if (!res.ok || payload.error) { setStatus('error'); return }
      setData(payload); setStatus('idle')
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ query: q, data: payload })) } catch {}
    } catch {
      setStatus('error')
    }
  }

  function reset() {
    setData(null); setQuery(''); setInput(''); setStatus('idle')
    try { sessionStorage.removeItem(STORAGE_KEY) } catch {}
  }

  // Leftover events not placed in any group → "More events nearby"
  const groupedIds = new Set((data?.groups ?? []).flatMap(g => g.event_ids))
  const leftovers  = data ? Object.keys(data.events).filter(id => !groupedIds.has(id)) : []
  const isEmpty    = !data && status !== 'loading'
  const noResults  = data && Object.keys(data.events).length === 0

  return (
    <div className="flex-1 flex flex-col min-h-0">

      {/* Search bar — always present; centered when idle, top when results shown */}
      <div className={isEmpty ? 'flex-1 flex flex-col justify-center' : ''}>
        <div className="max-w-2xl mx-auto w-full px-4 py-4 space-y-4">
          <form
            onSubmit={e => { e.preventDefault(); run(input) }}
            className="flex gap-2"
          >
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={SUGGESTIONS[0].toLowerCase()}
              disabled={status === 'loading'}
              autoComplete="off"
              className="flex-1 bg-surface-raised border border-edge rounded-sm px-3 py-2 text-sm
                         text-content-primary placeholder:text-content-muted
                         focus:outline-none focus:border-content-muted disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!input.trim() || status === 'loading'}
              className="px-4 py-2 text-sm rounded-sm bg-surface-raised border border-edge
                         text-content-secondary disabled:opacity-40 transition-opacity"
            >
              Search
            </button>
            {data && (
              <button
                type="button"
                onClick={reset}
                className="px-4 py-2 text-sm rounded-sm bg-surface-raised border border-edge
                           text-content-muted hover:text-content-secondary transition-colors whitespace-nowrap"
              >
                Clear
              </button>
            )}
          </form>

          {isEmpty && (
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => run(s)}
                  className="text-sm px-3 py-1.5 rounded-sm bg-surface-card border border-edge
                             text-content-muted hover:text-content-secondary transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Results */}
      {!isEmpty && (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-4 pb-8 space-y-6">

            {status === 'loading' && (
              <p className="text-base tracking-widest" aria-label="Searching">
                {pins || '…'}
              </p>
            )}

            {status === 'error' && (
              <p className="text-sm text-content-muted">Something went wrong. Try again.</p>
            )}

            {noResults && (
              <p className="text-sm text-content-muted">
                Nothing matching “{query}”. New events appear as more boards are photographed.
              </p>
            )}

            {data && !noResults && (
              <>
                {/* Orienting line — caption, not conversation */}
                {data.lead && (
                  <p className="text-sm leading-relaxed text-content-secondary">{data.lead}</p>
                )}

                {/* Groups */}
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

                {/* Leftovers */}
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
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}