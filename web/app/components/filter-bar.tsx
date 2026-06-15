'use client'
// app/components/filter-bar.tsx
import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback } from 'react'
import { CATEGORIES, categoryColor, hexToRgba } from '@/lib/categories'

interface FilterBarProps {
  activeCategory?: string
}

export function FilterBar({ activeCategory }: FilterBarProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const updateFilter = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (value === 'all' || value === '') {
        params.delete(key)
         params.delete('q')
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
        const color = categoryColor(cat.value)
        return (
          <button
            key={cat.value}
            onClick={() => updateFilter('category', cat.value)}
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