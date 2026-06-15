'use client'
// app/components/search-input.tsx
import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useRef, useState } from 'react'

interface SearchInputProps {
  activeQuery?: string
}

export function SearchInput({ activeQuery }: SearchInputProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [inputValue, setInputValue] = useState(activeQuery ?? '')

  const updateQuery = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (value === '') {
        params.delete('q')
      } else {
        params.set('q', value)
      }
      router.push(`?${params.toString()}`, { scroll: false })
    },
    [router, searchParams]
  )

  const handleSearch = (value: string) => {
    setInputValue(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => updateQuery(value), 300)
  }

  const clearSearch = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setInputValue('')
    updateQuery('')
  }

  return (
    <div className="relative">
      <label htmlFor="event-search" className="sr-only">Search events</label>
      <input
        id="event-search"
        type="text"
        value={inputValue}
        onChange={e => handleSearch(e.target.value)}
        placeholder="Search events…"
        className="w-full px-3 py-1.5 rounded text-sm bg-transparent outline-none placeholder:text-content-muted"
        style={{
          border: '1px solid var(--color-edge-subtle)',
          color: 'var(--color-content-primary)',
          paddingRight: inputValue ? '2rem' : undefined,
        }}
      />
      {inputValue && (
        <button
          onClick={clearSearch}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-content-muted hover:text-content-secondary transition-colors"
          aria-label="Clear search"
        >
          ✕
        </button>
      )}
    </div>
  )
}