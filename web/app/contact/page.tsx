// app/contact/page.tsx
//
// Client component — needs form state, so this isn't server-rendered like
// /events/[id]. Posts to /api/contact (see route.ts), which does the
// honeypot/timing check before the row ever reaches contact_messages.
//
// Styling follows the same tokens as the rest of the app (global.css /
// Tailwind v4 @theme inline): bg-surface-page, bg-surface-card,
// border-edge-subtle, text-content-primary/secondary/muted, bg-brand.
// Heading uses the Permanent Marker treatment used elsewhere (AboutCard,
// EmptyState, the app title itself).
//
// PageHeader usage follows the /search page's pattern: explicit
// cityLabel={null} cities={[]} isDetected={false} alongside a custom
// subtitle, which renders the subtitle as plain text with no city picker
// (this page has no location context, same reasoning as /events/[id]
// and /search).

'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/app/components/page-header'

const CATEGORIES = [
  { value: 'bug', label: "Something's broken" },
  { value: 'wrong_info', label: 'Wrong event info' },
  { value: 'takedown', label: 'Takedown request' },
  { value: 'feedback', label: 'Feedback' },
  { value: 'other', label: 'Something else' },
] as const

type Status = 'idle' | 'submitting' | 'sent' | 'error'

export default function ContactPage() {
  const [email, setEmail] = useState('')
  const [category, setCategory] = useState<string>('other')
  const [message, setMessage] = useState('')
  const [company, setCompany] = useState('') // honeypot — real visitors never see this field
  const [status, setStatus] = useState<Status>('idle')

  // Captured once on mount, not on every render — the API route checks
  // how much time passed between page load and submit.
  const renderedAtRef = useRef(Date.now())

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!message.trim() || status === 'submitting') return

    setStatus('submitting')
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim() || undefined,
          category,
          message: message.trim(),
          context_url: window.location.href,
          company,
          renderedAt: renderedAtRef.current,
        }),
      })
      if (!res.ok) throw new Error('request failed')
      setStatus('sent')
      setMessage('')
      setEmail('')
    } catch {
      setStatus('error')
    }
  }

  return (
    <div className="min-h-screen bg-surface-page">
      <PageHeader
        leftSlot={
          <Link
            href="/"
            className="text-sm text-content-muted hover:text-content-secondary transition-colors"
          >
            ← Events
          </Link>
        }
        rightSlot={<div />}
        subtitle="Get in touch"
        cityLabel={null}
        cities={[]}
        isDetected={false}
      />

      <main className="max-w-lg mx-auto px-4 py-10">
        {status === 'sent' ? (
          <div className="text-center py-16">
            <p className="text-sm text-content-muted">
              Thanks for reaching out.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="category" className="block text-sm text-content-secondary mb-1.5">
                What&apos;s this about?
              </label>
              <select
                id="category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full bg-surface-card border border-edge-subtle rounded-md px-3 py-2
                           text-content-primary text-sm focus:outline-none focus:border-content-accent"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="message" className="block text-sm text-content-secondary mb-1.5">
                Message
              </label>
              <textarea
                id="message"
                required
                rows={6}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What's going on?"
                className="w-full bg-surface-card border border-edge-subtle rounded-md px-3 py-2
                           text-content-primary text-sm resize-none focus:outline-none focus:border-content-accent"
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-sm text-content-secondary mb-1.5">
                Email <span className="text-content-muted">(optional — only if you want a reply)</span>
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full bg-surface-card border border-edge-subtle rounded-md px-3 py-2
                           text-content-primary text-sm focus:outline-none focus:border-content-accent"
              />
            </div>

            {/* Honeypot. Hidden off-screen rather than display:none — some bots skip
                display:none fields specifically, off-screen positioning is a bit more robust. */}
            <div className="absolute -left-[9999px]" aria-hidden="true">
              <label htmlFor="company">Company</label>
              <input
                id="company"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
            </div>

            <button
              type="submit"
              disabled={status === 'submitting'}
              className="w-full bg-brand text-surface-page font-medium rounded-md py-2.5 text-sm
                         disabled:opacity-50 transition-opacity"
            >
              {status === 'submitting' ? 'Sending…' : 'Send message'}
            </button>

            {status === 'error' && (
              <p className="text-sm text-center text-danger">
                Something went wrong on our end — nothing was lost, just try again.
              </p>
            )}
          </form>
        )}
      </main>
    </div>
  )
}