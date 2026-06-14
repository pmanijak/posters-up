'use client'

// app/components/filter-bar.tsx

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback } from 'react'

const CATEGORIES = [
  { value: 'all',         label: 'All' },
  { value: 'music',       label: 'Music' },
  { value: 'film',        label: 'Film' },
  { value: 'theater',     label: 'Theater' },
  { value: 'dance',       label: 'Dance' },
  { value: 'comedy',      label: 'Comedy' },
  { value: 'spoken_word', label: 'Spoken Word' },
  { value: 'visual_art',  label: 'Art' },
  { value: 'market',      label: 'Market' },
  { value: 'workshop',    label: 'Workshop' },
  { value: 'community',   label: 'Community' },
  { value: 'fundraiser',  label: 'Fundraiser' },
  { value: 'other',       label: 'Other' },
]

const WHEN_OPTIONS = [
  { value: 'week',     label: 'This week' },
  { value: 'all',      label: 'All' },
]

interface FilterBarProps {
  activeCategory?: string
  activeWhen: string
}

export function FilterBar({ activeCategory, activeWhen }: FilterBarProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const updateFilter = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (value === 'all' || value === 'upcoming') {
        params.delete(key)
      } else {
        params.set(key, value)
      }
      router.push(`?${params.toString()}`, { scroll: false })
    },
    [router, searchParams]
  )

  const chipBase: React.CSSProperties = {
    padding: '3px 10px',
    borderRadius: '999px',
    fontSize: '12px',
    fontWeight: 500,
    cursor: 'pointer',
    border: '1px solid transparent',
    transition: 'all 0.1s',
    whiteSpace: 'nowrap' as const,
  }

  const chipActive: React.CSSProperties = {
    ...chipBase,
    background: '#1C1713',
    color: '#F7F3EE',
    borderColor: '#1C1713',
  }

  const chipInactive: React.CSSProperties = {
    ...chipBase,
    background: 'transparent',
    color: '#8A7E72',
    borderColor: '#E0D8CE',
  }

  return (
    <div className="space-y-2">
      {/* When */}
      <div className="flex gap-1.5">
        {WHEN_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            style={activeWhen === opt.value ? chipActive : chipInactive}
            onClick={() => updateFilter('when', opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Category — scrollable on mobile */}
      <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
        {CATEGORIES.map((cat) => {
          const isActive =
            cat.value === 'all'
              ? !activeCategory || activeCategory === 'all'
              : activeCategory === cat.value
          return (
            <button
              key={cat.value}
              style={isActive ? chipActive : chipInactive}
              onClick={() => updateFilter('category', cat.value)}
            >
              {cat.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}