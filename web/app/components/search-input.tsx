'use client'
// app/components/search-input.tsx
import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useRef } from 'react'

interface SearchInputProps {
  activeQuery?: string
}

export function SearchInput({ activeQuery }: SearchInputProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => updateQuery(value), 300)
  }

  const clearSearch = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (inputRef.current) inputRef.current.value = ''
    updateQuery('')
  }

  return (
    <div className="relative">
      <label htmlFor="event-search" className="sr-only">Search events</label>
      <input
        ref={inputRef}
        id="event-search"
        type="text"
        defaultValue={activeQuery ?? ''}
        key={activeQuery ?? ''}
        onChange={e => handleSearch(e.target.value)}
        placeholder="Search events…"
        className="w-full px-3 py-1.5 rounded text-sm bg-transparent outline-none placeholder:text-content-muted"
        style={{
          border: '1px solid var(--color-edge-subtle)',
          color: 'var(--color-content-primary)',
        }}
      />
      {activeQuery && (
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