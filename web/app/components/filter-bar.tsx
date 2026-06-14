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

interface FilterBarProps {
  activeCategory?: string
}

export function FilterBar({ activeCategory }: FilterBarProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const updateFilter = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (value === 'all') {
        params.delete(key)
      } else {
        params.set(key, value)
      }
      router.push(`?${params.toString()}`, { scroll: false })
    },
    [router, searchParams]
  )

  return (
    <div className="flex flex-wrap gap-1.5">
      {CATEGORIES.map((cat) => {
        const isActive =
          cat.value === 'all'
            ? !activeCategory || activeCategory === 'all'
            : activeCategory === cat.value
        return (
          <button
            key={cat.value}
            onClick={() => updateFilter('category', cat.value)}
            className={[
              'px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
              isActive
                ? 'bg-content-secondary text-surface-page border-content-secondary'
                : 'bg-transparent text-content-muted border-edge-subtle hover:border-edge',
            ].join(' ')}
          >
            {cat.label}
          </button>
        )
      })}
    </div>
  )
}