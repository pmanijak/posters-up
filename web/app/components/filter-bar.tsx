'use client'
// app/components/filter-bar.tsx
import { CATEGORIES, categoryColor, hexToRgba } from '@/lib/categories'
import { useFilters } from './filters-provider'

interface FilterBarProps {
  activeCategory?: string
}

export function FilterBar({ activeCategory }: FilterBarProps) {
  const { setQuery, pushParams, clearResults } = useFilters()

  const handleCategory = (value: string) => {
    // A category tap is a deliberate switch back to browsing — leave any active
    // AI search. Without this, the new category filters the (hidden) EventFeed
    // while SearchResults still owns the surface: the pill looks active but
    // nothing visibly changes.
    clearResults()

    setQuery('')                              // clear the search input locally
    if (value === 'all') {
      pushParams({ category: null, q: null })   // clear both from the URL
    } else {
      pushParams({ category: value, q: null })  // drop q so we exit interpreted search
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {CATEGORIES.map((cat) => {
        const isActive =
          cat.value === 'all'
            ? !activeCategory || activeCategory === 'all'
            : activeCategory === cat.value
        const color = categoryColor(cat.value)
        return (
          <button
            key={cat.value}
            onClick={() => handleCategory(cat.value)}
            className="px-2.5 py-1 rounded text-xs font-medium transition-colors"
            style={
              isActive
                ? {
                    color,
                    background: hexToRgba(color, 0.15),
                    border: `1px solid ${hexToRgba(color, 0.3)}`,
                  }
                : {
                    color: 'var(--color-content-secondary)',
                    background: 'transparent',
                    border: '1px solid var(--color-content-muted)',
                  }
            }
          >
            {cat.label}
          </button>
        )
      })}
    </div>
  )
}