'use client'
// app/components/search-results.tsx
import { useFilters } from './filters-provider'
import { EventCard } from './event-card'

export function SearchResults() {
  const { query, searchData: data, searchStatus: status, pins } = useFilters()

  const groupedIds = new Set((data?.groups ?? []).flatMap(g => g.event_ids))
  const leftovers  = data ? Object.keys(data.events).filter(id => !groupedIds.has(id)) : []

  const displayedCount = data?.groups.length && data.groups.length > 0
    ? groupedIds.size
    : leftovers.length

  if (status === 'idle' && !data) return null

  return (
    <div className="space-y-6">
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
        Object.keys(data.events).length === 0 ? (
          <p className="text-sm text-content-muted">
            Nothing found for "{query}". New events appear as more boards are photographed.
          </p>
        ) : (
          <>
            {data.lead && (
              <p className="text-sm leading-relaxed text-content-secondary">{data.lead}</p>
            )}
            {data.groups.length > 0 ? (
              // Grouped results — leftovers are intentionally hidden.
              // Claude looked at them and decided they didn't fit the query;
              // showing them anyway would dilute the answer.
              data.groups.map(group => (
                <section key={group.label} className="space-y-3">
                  <h2 className="text-xs uppercase tracking-wider text-content-muted">
                    {group.label}
                  </h2>
                  {group.event_ids.map(id => (
                    <EventCard key={id} event={data.events[id]} />
                  ))}
                </section>
              ))
            ) : (
              // Fallback: present_results returned no groups (API error or uniform
              // result set). Show everything as a plain ungrouped list.
              <section className="space-y-3">
                {leftovers.map(id => (
                  <EventCard key={id} event={data.events[id]} />
                ))}
              </section>
            )}
            <p className="text-center text-xs pt-4 text-content-muted">
              {displayedCount} events · "{query}"
            </p>
          </>
        )
      )}
    </div>
  )
}