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
        const color = cat.value === 'all' ? '#8A9E8F' : categoryColor(cat.value)

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
                    color: '#4A5A4E',
                    background: 'transparent',
                    border: '1px solid #3D4A41',
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