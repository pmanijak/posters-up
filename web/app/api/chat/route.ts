// app/api/chat/route.ts
//
// Streaming chat endpoint for the events assistant.
//
// Flow per turn:
//   1. First Claude call (non-streaming) — lets Claude decide to use search_events tool
//   2. Execute the tool: query events_public + fetch enrichment from event_sightings
//   3. Second Claude call (streaming) — answer piped back to client as SSE
//
// If Claude answers without a tool call (rare), the text is sent directly.
// Conversation history is maintained by the client as plain {role, content} pairs;
// tool_use/tool_result blocks are internal to this route and never sent to the client.
//
// Auth: uses SUPABASE_TELL_ME_MORE_KEY — same access level as tell-me-more route
// (needs event_sightings, which is not in any public view).

import { createClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { SITE_URL } from '@/lib/site'

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const MODEL         = 'claude-haiku-4-5-20251001'  // Haiku for cost; ~$0.001/query

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_TELL_ME_MORE_KEY!
)

// ── Date helpers ───────────────────────────────────────────────────────────

function pacificDate(offsetDays = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })
    .format(new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000))
}

// ── Tool definition ────────────────────────────────────────────────────────

const SEARCH_TOOL = {
  name: 'search_events',
  description:
    "Search for events in Olympia, WA that have been spotted on local bulletin boards. " +
    "Always call this tool before answering — don't rely on memory for current events.",
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Text to search in event names, descriptions, tags, and enrichment content. ' +
          'Leave empty to get all upcoming events.',
      },
      category: {
        type: 'string',
        description:
          'Filter by category: music, film, theater, dance, comedy, spoken_word, ' +
          'visual_art, market, workshop, community, fundraiser, party, other',
      },
      date_from: {
        type: 'string',
        description: 'Only show events on or after this date (YYYY-MM-DD)',
      },
      date_to: {
        type: 'string',
        description: 'Only show events on or before this date (YYYY-MM-DD)',
      },
      is_free: {
        type: 'boolean',
        description: 'If true, only return free events',
      },
    },
  },
}

// ── Format events for Claude ───────────────────────────────────────────────
// Returns a plain-text block Claude can reason over.
// Enrichment narrative is appended after flyer data.

function formatEvent(event: any, enrichment: any): string {
  const lines: string[] = [`**${event.name}**`]
  lines.push(`URL: ${SITE_URL}/events/${event.id}`)

  if (event.event_category) lines.push(`Category: ${event.event_category}`)

  // Date / time
  if (event.date_type === 'specific' && event.date_start) {
    const [y, m, d] = event.date_start.split('-').map(Number)
    const dateStr = new Date(y, m - 1, d).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
    })
    if (event.time_start) {
      const [h, min] = event.time_start.split(':').map(Number)
      const ampm = h >= 12 ? 'PM' : 'AM'
      const hour = h > 12 ? h - 12 : h === 0 ? 12 : h
      lines.push(`Date: ${dateStr} at ${hour}:${String(min).padStart(2, '0')} ${ampm}`)
    } else {
      lines.push(`Date: ${dateStr}`)
    }
  } else if (event.date_raw) {
    lines.push(`Date: ${event.date_raw}`)
  } else if (event.date_type === 'recurring') {
    lines.push('Recurring event')
  }

  if (event.location_name)  lines.push(`Location: ${event.location_name}`)
  if (event.location_address && !event.location_name) lines.push(`Address: ${event.location_address}`)

  // Talent from flyer
  const talent = event.talent as any[] | null
  if (talent?.length) {
    lines.push(`Featuring: ${talent.map((t: any) => t.name).join(', ')}`)
  }

  if (event.price_raw)     lines.push(`Price: ${event.price_raw}`)
  else if (event.is_free)  lines.push('Price: Free')

  if (event.age_restriction) lines.push(`Ages: ${event.age_restriction}`)

  if (event.description) lines.push(`Description: ${event.description}`)

  // Enrichment — appended after flyer data
  if (enrichment?.description) lines.push(`Context: ${enrichment.description}`)
  if (enrichment?.venue_context) lines.push(`Venue: ${enrichment.venue_context}`)

  // Talent bios from enrichment
  if (enrichment?.talent?.length) {
    for (const t of enrichment.talent as any[]) {
      if (t.bio) lines.push(`About ${t.name}: ${t.bio}`)
    }
  }

  if (event.tags?.length) lines.push(`Tags: ${event.tags.join(', ')}`)

  return lines.join('\n')
}

// ── Tool execution ─────────────────────────────────────────────────────────

async function executeSearch(input: {
  query?:     string
  category?:  string
  date_from?: string
  date_to?:   string
  is_free?:   boolean
}): Promise<string> {
  const today      = pacificDate(0)
  const thirtyOut  = pacificDate(30)

  // Query events_public — already filters by confidence and is_active
  let q = supabase
    .from('events_public')
    .select(
      'id, name, event_category, date_type, date_start, date_end, ' +
      'time_start, date_raw, location_name, location_address, description, ' +
      'price_raw, is_free, age_restriction, tags, talent'
    )
    .or(
      `and(date_start.lte.${thirtyOut},or(date_end.gte.${today},and(date_end.is.null,date_start.gte.${today}))),` +
      `date_type.in.(recurring,approximate,unknown)`
    )
    .order('date_start', { ascending: true, nullsFirst: false })
    .limit(12)

  if (input.query)              q = q.ilike('search_text', `%${input.query}%`)
  if (input.category)           q = q.eq('event_category', input.category)
  if (input.date_from)          q = q.gte('date_start', input.date_from)
  if (input.date_to)            q = q.lte('date_start', input.date_to)
  if (input.is_free === true)   q = q.eq('is_free', true)

  const { data: events, error } = await q

  if (error) {
    console.error('search_events error:', error)
    return 'Error searching events.'
  }
  if (!events?.length) {
    return 'No events found matching those criteria. New events are added as contributors photograph more boards around town.'
  }

  // Fetch enrichment for all returned events in one query
  const ids = (events as any[]).map(e => e.id)
  const { data: sightings } = await supabase
    .from('event_sightings')
    .select('event_id, enrichment_data, sighted_at')
    .in('event_id', ids)
    .not('enrichment_data', 'is', null)
    .order('sighted_at', { ascending: false })

  // Most recent enrichment per event
  const enrichmentMap = new Map<string, any>()
  for (const s of sightings ?? []) {
    if (!enrichmentMap.has(s.event_id)) {
      enrichmentMap.set(s.event_id, s.enrichment_data)
    }
  }

  const blocks = (events as any[]).map(e => formatEvent(e, enrichmentMap.get(e.id) ?? null))
  return `Found ${events.length} event${events.length !== 1 ? 's' : ''}:\n\n${blocks.join('\n\n---\n\n')}`
}

// ── System prompt ──────────────────────────────────────────────────────────
//
// Split into a static cacheable block and a dynamic date block.
// The static block is marked cache_control: ephemeral — Anthropic caches it
// for 5 minutes, saving input tokens on every query after the first.
// The date block is appended as a plain text block (not cached) so the cache
// key for the static portion stays stable across the day.
// Requires the anthropic-beta: prompt-caching-2024-07-31 header.

const SYSTEM_PROMPT_STATIC = `You are a helpful local events assistant for Posters Up (postersup.org), \
an app that discovers events from physical bulletin boards around Olympia, WA. \
Contributors photograph boards around town; AI extracts the events.

Always use the search_events tool before answering questions about events — \
don't answer from memory. For broad questions like "what's on this weekend," \
pass appropriate date_from/date_to filters. For specific queries, use the query field.

When presenting events:
- When mentioning a specific event by name, link it using a relative path: [Event Name](/events/EVENT_ID?ref=search)
- Write like a knowledgeable local, not a database printout
- Weave in the enrichment context (artist bios, venue vibe) when you have it — it makes events come alive
- Call out free events and age restrictions when relevant
- If nothing matches, say so simply and note that new events appear as more boards are photographed
- Keep responses tight — most users are on mobile`

function systemPrompt() {
  return [
    {
      type: 'text',
      text: SYSTEM_PROMPT_STATIC,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `Today is ${pacificDate(0)}.`,
    },
  ]
}

// ── Claude API helper ──────────────────────────────────────────────────────

function claudeHeaders() {
  return {
    'Content-Type':      'application/json',
    'x-api-key':         process.env.ANTHROPIC_CHAT_API_KEY!,
    'anthropic-version': '2023-06-01',
    'anthropic-beta':    'prompt-caching-2024-07-31',
  }
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { messages } = await req.json()

  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response('Bad request', { status: 400 })
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))

      try {
        // ── Step 1: First call — get tool use ───────────────────────────
        const res1 = await fetch(ANTHROPIC_API, {
          method:  'POST',
          headers: claudeHeaders(),
          body:    JSON.stringify({
            model:    MODEL,
            max_tokens: 1024,
            system:   systemPrompt(),
            tools:    [SEARCH_TOOL],
            messages,
          }),
        })

        const msg1 = await res1.json()

        if (!res1.ok) {
          send({ error: 'Search failed. Try again.' })
          controller.close()
          return
        }

        // Answered without tool use — send directly and exit
        if (msg1.stop_reason !== 'tool_use') {
          const text = msg1.content?.find((b: any) => b.type === 'text')?.text ?? ''
          send({ text })
          send({ done: true })
          controller.close()
          return
        }

        // ── Step 2: Execute tool ─────────────────────────────────────────
        const toolBlock  = msg1.content.find((b: any) => b.type === 'tool_use')
        const toolResult = await executeSearch(toolBlock.input)

        // ── Step 3: Second call — stream the answer ──────────────────────
        const updatedMessages = [
          ...messages,
          { role: 'assistant', content: msg1.content },
          {
            role:    'user',
            content: [{
              type:        'tool_result',
              tool_use_id: toolBlock.id,
              content:     toolResult,
            }],
          },
        ]

        const res2 = await fetch(ANTHROPIC_API, {
          method:  'POST',
          headers: claudeHeaders(),
          body:    JSON.stringify({
            model:    MODEL,
            max_tokens: 1024,
            system:   systemPrompt(),
            tools:    [SEARCH_TOOL],
            stream:   true,
            messages: updatedMessages,
          }),
        })

        if (!res2.ok) {
          send({ error: 'Something went wrong. Try again.' })
          controller.close()
          return
        }

        // Pipe Anthropic SSE → client SSE
        const reader  = res2.body!.getReader()
        const decoder = new TextDecoder()
        let   buffer  = ''

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
              const event = JSON.parse(data)
              if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                send({ text: event.delta.text })
              }
            } catch {}
          }
        }

        send({ done: true })
        controller.close()

      } catch (err) {
        console.error('search route error:', err)
        send({ error: 'Something went wrong. Try again.' })
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  })
}