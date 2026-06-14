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

  const chipBase: React.CSSProperties = {
    padding: '3px 10px',
    borderRadius: '999px',
    fontSize: '12px',
    fontWeight: 500,
    cursor: 'pointer',
    border: '1px solid transparent',
    transition: 'all 0.1s',
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
    <div className="flex flex-wrap gap-1.5">
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
  )
}