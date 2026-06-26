'use client'

// app/search/search-interface.tsx
//
// Client component: search history, input, streaming response display.
// Parent (page.tsx) renders PageHeader above this component.
//
// Message format sent to the API: {role: 'user'|'assistant', content: string}[]
// Tool use is internal to the API route — this component never sees it.
//
// During streaming, pseudo-random bulletin board / pushpin emojis accumulate
// as a loading indicator. The full result swaps in on completion.
//
// Search history is persisted to sessionStorage so navigation away and back
// (e.g. tapping an event link) doesn't lose the conversation.
// sessionStorage dies with the tab — no cross-session persistence.

import { useState, useRef, useEffect, type FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'

interface Message {
  role:    'user' | 'assistant'
  content: string
  loading?: boolean  // true while streaming; full content renders on completion
}

const STORAGE_KEY = 'search-history'

// Weighted toward pushpin since it's more recognisable as "posted on a board"
const LOADING_EMOJIS = ['📌', '📌', '📌', '📋', '📌', '📌', '📋', '📌']

function randomEmoji(): string {
  return LOADING_EMOJIS[Math.floor(Math.random() * LOADING_EMOJIS.length)]
}

const SUGGESTIONS = [
  'What\'s something fun happening?',
  'Any free shows coming up?',
  'Music this week?',
  'Anything all-ages?',
]

export function SearchInterface() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const bottomRef     = useRef<HTMLDivElement>(null)
  const inputRef      = useRef<HTMLInputElement>(null)
  const emptyInputRef = useRef<HTMLInputElement>(null)

  // Restore messages from sessionStorage on mount
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY)
      if (saved) setMessages(JSON.parse(saved))
    } catch {}
  }, [])

  // Persist messages to sessionStorage whenever they change.
  // Guard against empty array clobbering a saved session on mount.
  useEffect(() => {
    try {
      if (messages.length > 0) {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages))
      }
    } catch {}
  }, [messages])

  // Scroll to bottom whenever messages update
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function submit(text: string) {
    if (!text.trim() || loading) return

    const userMsg: Message = { role: 'user', content: text.trim() }
    setInput('')
    setLoading(true)

    // Add user message + empty loading placeholder
    setMessages(prev => [...prev, userMsg, { role: 'assistant', content: '', loading: true }])

    try {
      const res = await fetch('/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          messages: [...messages, userMsg].map(m => ({
            role:    m.role,
            content: m.content,
          })),
        }),
      })

      if (!res.ok) throw new Error(`${res.status}`)

      const reader  = res.body!.getReader()
      const decoder = new TextDecoder()
      let   buffer  = ''
      let   accumulated  = ''
      let   chunkCount   = 0
      let   emojiDisplay = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (!data) continue

          try {
            const payload = JSON.parse(data)

            if (payload.text) {
              accumulated += payload.text
              chunkCount++

              // Add a new emoji roughly every 8 chunks
              if (chunkCount % 8 === 1) {
                emojiDisplay += (emojiDisplay ? '  ' : '') + randomEmoji()
                const display = emojiDisplay
                setMessages(prev => {
                  const next = [...prev]
                  next[next.length - 1] = {
                    ...next[next.length - 1],
                    content: display,
                    loading: true,
                  }
                  return next
                })
              }
            }

            if (payload.error) {
              setMessages(prev => {
                const next = [...prev]
                next[next.length - 1] = { role: 'assistant', content: payload.error, loading: false }
                return next
              })
            }
          } catch {}
        }
      }

      // Stream complete — swap in the full result
      setMessages(prev => {
        const next = [...prev]
        next[next.length - 1] = {
          role:    'assistant',
          content: accumulated,
          loading: false,
        }
        return next
      })

    } catch {
      setMessages(prev => {
        const next = [...prev]
        next[next.length - 1] = {
          role:    'assistant',
          content: 'Something went wrong. Try again.',
          loading: false,
        }
        return next
      })
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    submit(input)
  }

  function handleEmptySubmit(e: FormEvent) {
    e.preventDefault()
    submit(input)
  }

  function clearSearch() {
    setMessages([])
    sessionStorage.removeItem(STORAGE_KEY)
  }

  const isEmpty = messages.length === 0

  return (
    <div className="flex-1 flex flex-col min-h-0">

      {/* ── Empty state — centered search input ──────────────────────── */}
      {isEmpty ? (
        <div className="flex-1 flex flex-col justify-center">
          <div className="max-w-2xl mx-auto w-full px-4 space-y-4">
            <form onSubmit={handleEmptySubmit} className="flex gap-2">
              <input
                ref={emptyInputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="What would you like to do?"
                disabled={loading}
                autoComplete="off"
                className="
                  flex-1 bg-surface-raised border border-edge rounded-sm
                  px-3 py-2 text-sm text-content-primary
                  placeholder:text-content-muted
                  focus:outline-none focus:border-content-muted
                  disabled:opacity-50
                "
              />
              <button
                type="submit"
                disabled={!input.trim() || loading}
                className="
                  px-4 py-2 text-sm rounded-sm
                  bg-surface-raised border border-edge
                  text-content-secondary
                  disabled:opacity-40
                  transition-opacity
                "
              >
                Search
              </button>
            </form>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => submit(s)}
                  className="text-sm px-3 py-1.5 rounded-sm bg-surface-card border border-edge text-content-muted hover:text-content-secondary transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* ── Results ────────────────────────────────────────────────── */}
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-4 py-6 space-y-4 pb-4">
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`
                      text-sm leading-relaxed
                      ${m.role === 'user'
                        ? 'max-w-[85%] rounded-sm px-4 py-3 bg-surface-raised text-content-primary'
                        : 'w-full text-content-secondary'}
                    `}
                  >
                    {m.role === 'user' ? (
                      m.content
                    ) : m.loading ? (
                      // Loading state — show accumulated emojis, or ellipsis before first emoji
                      <span className="text-base tracking-widest">
                        {m.content || '…'}
                      </span>
                    ) : m.content ? (
                      <ReactMarkdown
                        components={{
                          p:      ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                          strong: ({ children }) => <strong className="font-semibold text-content-primary">{children}</strong>,
                          ul:     ({ children }) => <ul className="mt-1 mb-2 space-y-1 last:mb-0">{children}</ul>,
                          li:     ({ children }) => <li className="flex gap-2"><span className="text-content-muted shrink-0">·</span><span>{children}</span></li>,
                          a:      ({ href, children }) => (
                            <a
                              href={href}
                              target={href?.startsWith('/') ? '_self' : '_blank'}
                              rel={href?.startsWith('/') ? undefined : 'noopener noreferrer'}
                              className="underline underline-offset-2 decoration-dotted text-content-secondary hover:text-content-primary transition-colors"
                            >
                              {children}
                            </a>
                          ),
                        }}
                      >
                        {m.content}
                      </ReactMarkdown>
                    ) : null}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          </div>

          {/* ── Bottom input bar — shown once results appear ──────────── */}
          <div className="border-t border-edge bg-surface-page">
            <form
              onSubmit={handleSubmit}
              className="max-w-2xl mx-auto px-4 py-3 flex gap-2"
            >
              <input
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="Ask a follow-up..."
                disabled={loading}
                autoComplete="off"
                className="
                  flex-1 bg-surface-raised border border-edge rounded-sm
                  px-3 py-2 text-sm text-content-primary
                  placeholder:text-content-muted
                  focus:outline-none focus:border-content-muted
                  disabled:opacity-50
                "
              />
              <button
                type="submit"
                disabled={!input.trim() || loading}
                className="
                  px-4 py-2 text-sm rounded-sm
                  bg-surface-raised border border-edge
                  text-content-secondary
                  disabled:opacity-40
                  transition-opacity
                "
              >
                Search
              </button>
              <button
                type="button"
                onClick={clearSearch}
                className="
                  px-4 py-2 text-sm rounded-sm
                  bg-surface-raised border border-edge
                  text-content-muted hover:text-content-secondary
                  transition-colors whitespace-nowrap
                "
              >
                New search
              </button>
            </form>
          </div>
        </>
      )}

    </div>
  )
}