'use client'

import { useState } from 'react'
import type { Database } from '@/lib/database.generated'
import { SITE_URL } from '@/lib/site'

type EventRow = Database['public']['Views']['events_public']['Row']

export function EventActions({ event }: { event: EventRow }) {
  const [copied, setCopied] = useState(false)

  // Mirrors the /calendar route's own 404 condition — an event without a
  // specific date has nothing to put on a calendar.
  const canAddToCalendar = event.date_type === 'specific' && !!event.date_start
  const eventUrl = `${SITE_URL}/events/${event.id}`

  async function handleShare() {
    // Prefer the native share sheet where available (mobile) —
    // falls back to clipboard copy on desktop browsers without it.
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title: event.name ?? 'Event', url: eventUrl })
      } catch {
        // User dismissed the share sheet — not an error, no-op.
      }
      return
    }
    try {
      await navigator.clipboard.writeText(eventUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API blocked (e.g. insecure context) — silently fail.
    }
  }

  return (
    <div className="mt-4">
      {/* Perforated tear line — the tear-off tab on a real flyer, echoed
          digitally. Signature element tying this back to the paper object
          the app indexes, not just a generic action row. */}
      <div className="border-t border-dashed border-edge" aria-hidden="true" />
      <div className="flex items-center justify-between pt-3">
        {canAddToCalendar ? (
          // Plain <a>, not next/link's Link — this is a file download
          // (Content-Disposition: attachment), not a page navigation.
          // Link's prefetching would fire the download request early.
          <a
            href={`/events/${event.id}/calendar`}
            className="inline-flex items-center gap-2 py-2 -my-2 text-sm text-content-muted hover:text-content-secondary transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="1" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
            Add to calendar
          </a>
        ) : (
          <span />
        )}
        <button
          onClick={handleShare}
          className="inline-flex items-center gap-2 py-2 -my-2 text-sm text-content-muted hover:text-content-secondary transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
          </svg>
          {copied ? 'Link copied' : 'Share'}
        </button>
      </div>
    </div>
  )
}