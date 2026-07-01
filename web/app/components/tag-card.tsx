import Link from 'next/link'

interface TagCardProps {
  tags:       string[]
  activeTag?: string   // currently active ?tag= value, if any
}

// Shown in two places:
// 1. In the feed at a natural break point when no filter is active (discovery)
// 2. Below the search input when ?tag= is active (switching between tags)
//
// Uses ?tag= rather than ?q= so the discover page can distinguish a tag cloud
// click from a typed search or event card tag click — only ?tag= pins this card.
export function TagCard({ tags, activeTag }: TagCardProps) {
  if (tags.length === 0) return null

  return (
    <div className="rounded-sm border border-dashed border-edge p-4 space-y-3">
      <p className="text-xs font-mono tracking-wider uppercase text-content-muted">Tagged nearby</p>
      <div className="flex flex-wrap gap-1.5">
        {tags.map(tag => {
          const isActive = tag.toLowerCase() === activeTag?.toLowerCase()
          return (
            <Link
              key={tag}
              href={isActive ? '/' : `/?tag=${encodeURIComponent(tag)}`}
              className="text-xs px-2 py-0.5 rounded-full transition-colors"
              style={
                isActive
                  ? { background: 'var(--color-content-muted)', color: 'var(--color-surface-page)' }
                  : { background: 'var(--color-surface-raised)', color: 'var(--color-content-muted)' }
              }
            >
              {tag}
            </Link>
          )
        })}
      </div>
    </div>
  )
}