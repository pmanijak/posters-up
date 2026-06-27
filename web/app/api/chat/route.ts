// app/api/chat/route.ts
//
// Search endpoint for the events feed. Two-step, both forced:
//   1. Claude calls search_events (date parsing, category, free, etc.)
//   2. We run the query, then Claude calls present_results to assign each
//      event to a plain-language group and write one orienting line.
//
// Returns JSON (not SSE): { lead, groups:[{label, event_ids}], events:{id: row} }.
// The client renders real EventCards from `events`; `groups` only carries
// label + ordering. Claude never sees or builds links — it groups by ID.
//
// Auth: SUPABASE_TELL_ME_MORE_KEY — needs event_sightings (not in any public view).

import { createClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const MODEL         = 'claude-haiku-4-5-20251001'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_TELL_ME_MORE_KEY!
)

// Full card shape — must match the EventCard `Event` interface so cards render
// identically to the home feed. Pulled from events_public (same view the feed uses).
const CARD_COLUMNS =
  'id, name, content_type, event_category, tags, flyer_style, date_type, ' +
  'date_start, date_end, time_start, time_end, recurrence_rule, date_raw, ' +
  'location_name, location_address, description, contact, event_url, ' +
  'price_raw, is_free, age_restriction, is_outdoor, accessibility, ' +
  'confidence_score, sighting_count, last_sighted_at, has_enrichment, ' +
  'organization_name, venue_name, talent'

// ── Date helpers ───────────────────────────────────────────────────────────

function pacificDate(offsetDays = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })
    .format(new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000))
}

// ── Tools ──────────────────────────────────────────────────────────────────

const SEARCH_TOOL = {
  name: 'search_events',
  description:
    'Search events spotted on Olympia, WA bulletin boards. Always call before answering.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'ONLY concrete tokens that would literally appear on a flyer: an artist or ' +
          'band name, a genre word ("punk", "jazz"), a venue name. This is a literal ' +
          'substring match, not a concept search. ' +
          'Do NOT use it for moods, vibes, audiences, or occasions — "fun for singles", ' +
          '"something low-key", "date night", "family friendly" are NOT flyer words and ' +
          'will match nothing. For those, leave query EMPTY, pull the broad set with ' +
          'date/category/is_free filters only, and sort it out in present_results. ' +
          'When unsure whether a word is on the flyer or just the vibe, leave it empty.',
      },
      category: {
        type: 'string',
        description:
          'music, film, theater, dance, comedy, spoken_word, visual_art, market, ' +
          'workshop, community, fundraiser, party, other',
      },
      date_from: {
        type: 'string',
        description: 'YYYY-MM-DD. Derive from natural language: "this weekend" → coming Saturday, ' +
          '"next month" → first of next month, "in July" → 2026-07-01, "tomorrow" → tomorrow.',
      },
      date_to: {
        type: 'string',
        description: 'YYYY-MM-DD. "this weekend" → coming Sunday, "next month" → last of next month.',
      },
      is_free: { type: 'boolean', description: 'If true, only free events.' },
      random:  { type: 'boolean', description: 'Shuffle for "surprise me" / "anything good?".' },
    },
  },
}

const PRESENT_TOOL = {
  name: 'present_results',
  description:
    'Organize the search results for display. Write one short orienting line, then ' +
    'sort the events into a few plain-language groups so the user can land on what ' +
    'they want without scanning everything.',
  input_schema: {
    type: 'object',
    properties: {
      lead: {
        type: 'string',
        description:
          'ONE short sentence (max ~20 words) that orients the user to the set: which ' +
          'piles exist, what stands out. Plain local voice, not an assistant voice. ' +
          'Point at the events — never editorialize ("great show!"), never invent a ' +
          'detail not in the data, never claim something is worth their time. If a read ' +
          'is inferred (touring act, family-friendly), it must be supported by the ' +
          'event data shown. Empty string if a single group covers everything.',
      },
      groups: {
        type: 'array',
        description:
          '2–4 groups, each a real pile that exists in THESE results. Groups may cut ' +
          'across category (free, all-ages, outdoor, late-night, touring). Use 1 group ' +
          'only if the set is genuinely uniform. Every event need not be placed — ' +
          'leftovers are shown under "More" automatically.',
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description: 'Plain, concrete, ≤3 words. e.g. "Free & outdoor", "All-ages shows", ' +
                '"Family workshops". Never vague ("Vibes", "Picks") — that reads as a machine.',
            },
            event_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs from the results, in display order.',
            },
          },
          required: ['label', 'event_ids'],
        },
      },
    },
    required: ['lead', 'groups'],
  },
}

// ── Tool execution ─────────────────────────────────────────────────────────
// Returns the full rows (for the client to render as cards) plus a compact
// text block (for Claude to reason over and group by ID).

function formatForPrompt(e: any, enrichment: any, random: boolean): string {
  const lines: string[] = [`ID: ${e.id}`, `Name: ${e.name}`]

  if (e.event_category) lines.push(`Category: ${e.event_category}`)

  if (e.date_type === 'specific' && e.date_start) {
    const [y, m, d] = e.date_start.split('-').map(Number)
    lines.push(`Date: ${new Date(y, m - 1, d).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
    })}`)
  } else if (e.date_raw) {
    lines.push(`Date: ${e.date_raw}`)
  } else if (e.date_type === 'recurring') {
    lines.push('Recurring event')
  }

  if (e.location_name) lines.push(`Location: ${e.location_name}`)
  if (e.talent?.length) lines.push(`Featuring: ${e.talent.map((t: any) => t.name).join(', ')}`)
  if (e.price_raw)    lines.push(`Price: ${e.price_raw}`)
  else if (e.is_free) lines.push('Price: Free')
  if (e.age_restriction) lines.push(`Ages: ${e.age_restriction}`)
  if (e.is_outdoor === true) lines.push('Outdoor')
  if (e.description) lines.push(`Description: ${e.description}`)
  if (enrichment?.description) lines.push(`Context: ${enrichment.description}`)
  if (enrichment?.venue_context) lines.push(`Venue: ${enrichment.venue_context}`)
  if (e.tags?.length) lines.push(`Tags: ${e.tags.join(', ')}`)

  // Buzz: suppressed for random queries so surprise picks don't bias to promoted.
  if (!random && e.sighting_count >= 3) {
    lines.push(`Buzz: on ${e.sighting_count} boards around town`)
  }

  return lines.join('\n')
}

async function executeSearch(input: {
  query?: string; category?: string; date_from?: string
  date_to?: string; is_free?: boolean; random?: boolean
}): Promise<{ rows: any[]; promptText: string }> {
  const today     = pacificDate(0)
  const windowEnd = input.date_to ?? pacificDate(30)

  let q = supabase
    .from('events_public')
    .select(CARD_COLUMNS)
    .or(
      `and(date_start.lte.${windowEnd},or(date_end.gte.${today},and(date_end.is.null,date_start.gte.${today}))),` +
      `date_type.in.(recurring,approximate,unknown)`
    )
    .order('date_start', { ascending: true, nullsFirst: false })
    .order('confidence_score', { ascending: false })
    .limit(50)

  if (input.query)            q = q.ilike('search_text', `%${input.query}%`)
  if (input.category)         q = q.eq('event_category', input.category)
  if (input.date_from)        q = q.gte('date_start', input.date_from)
  if (input.date_to)          q = q.lte('date_start', input.date_to)
  if (input.is_free === true) q = q.eq('is_free', true)

  const { data: events, error } = await q
  if (error) { console.error('search_events error:', error); return { rows: [], promptText: 'Error searching events.' } }
  if (!events?.length) return { rows: [], promptText: 'No events found.' }

  let rows = events as any[]
  if (input.random) {
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]]
    }
    rows = rows.slice(0, 3)
  }

  // Enrichment for grouping context (touring act, venue vibe) — fetched once.
  const ids = rows.map(e => e.id)
  const { data: sightings } = await supabase
    .from('event_sightings')
    .select('event_id, enrichment_data, sighted_at')
    .in('event_id', ids)
    .not('enrichment_data', 'is', null)
    .order('sighted_at', { ascending: false })

  const enrichmentMap = new Map<string, any>()
  for (const s of sightings ?? []) {
    if (!enrichmentMap.has(s.event_id)) enrichmentMap.set(s.event_id, s.enrichment_data)
  }

  const blocks = rows.map(e => formatForPrompt(e, enrichmentMap.get(e.id) ?? null, !!input.random))
  return { rows, promptText: `Found ${rows.length} events:\n\n${blocks.join('\n\n---\n\n')}` }
}

// ── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT_STATIC = `You organize a local events feed for Posters Up (postersup.org), \
which discovers events from physical bulletin boards around Olympia, WA.

Your job is to INTERPRET the query and ORGANIZE results — not to narrate them. \
The user reads the real event cards; you only sort them into useful piles and \
write one orienting line so they can land on what they want.

First call search_events (parse dates and filters from the query). Then call \
present_results to group the events and write the lead line.

Use the query field only for concrete words that would appear on a flyer (an act, \
a genre, a venue). For mood, vibe, audience, or occasion queries ("fun for singles", \
"something chill", "good for kids"), pass NO query — fetch the broad upcoming set and \
do the matching by grouping in present_results. Substring search can't find a vibe; \
grouping can.

Grouping principles:
- Make groups that actually help someone decide: free, all-ages, outdoor, touring acts, this weekend — whatever the result set and the query make relevant.
- 2–4 groups. One group only if the set is truly uniform. Labels must be plain and concrete — never "Vibes", "Picks", "Highlights".
- You don't have to place every event; leftovers appear under "More" automatically.
- The lead line orients ("A couple of free outdoor things, plus a touring punk show"). It never says an event is good, never invents detail, never says anything is "worth your time". Any inference (touring, family-friendly) must be grounded in the event data.
- Keep it tight — users are on mobile.`

function systemPrompt() {
  return [
    { type: 'text', text: SYSTEM_PROMPT_STATIC, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `Today is ${pacificDate(0)}.` },
  ]
}

function claudeHeaders() {
  return {
    'Content-Type':      'application/json',
    'x-api-key':         process.env.ANTHROPIC_CHAT_API_KEY!,
    'anthropic-version': '2023-06-01',
  }
}

// ── Route ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let query = ''
  try { query = (await req.json()).query ?? '' } catch {}
  if (typeof query !== 'string') return Response.json({ error: 'Bad request' }, { status: 400 })

  const baseMessages = [{ role: 'user', content: query || 'What is coming up?' }]

  try {
    // Step 1 — forced search_events
    const res1 = await fetch(ANTHROPIC_API, {
      method: 'POST', headers: claudeHeaders(),
      body: JSON.stringify({
        model: MODEL, max_tokens: 1024, system: systemPrompt(),
        tools: [SEARCH_TOOL, PRESENT_TOOL],
        tool_choice: { type: 'tool', name: 'search_events' },
        messages: baseMessages,
      }),
    })
    const msg1 = await res1.json()
    if (!res1.ok) return Response.json({ error: 'Search failed.' }, { status: 502 })

    const searchCall = msg1.content?.find((b: any) => b.type === 'tool_use')
    if (!searchCall) return Response.json({ lead: '', groups: [], events: {} })

    const searchInput = searchCall.input
    let { rows, promptText } = await executeSearch(searchInput)

    // If Claude passed a literal query and got nothing back, it probably used a vibe
    // phrase instead of a flyer token. Retry without the query — let present_results
    // do the concept matching instead. All other filters (date, is_free, category) are
    // preserved so the retry is still appropriately scoped.
    if (!rows.length && searchInput.query) {
      const retried = await executeSearch({ ...searchInput, query: undefined })
      rows = retried.rows
      promptText = retried.promptText
    }

    if (!rows.length) return Response.json({ lead: '', groups: [], events: {} })

    // Step 2 — forced present_results
    const res2 = await fetch(ANTHROPIC_API, {
      method: 'POST', headers: claudeHeaders(),
      body: JSON.stringify({
        model: MODEL, max_tokens: 1024, system: systemPrompt(),
        tools: [SEARCH_TOOL, PRESENT_TOOL],
        tool_choice: { type: 'tool', name: 'present_results' },
        messages: [
          ...baseMessages,
          { role: 'assistant', content: msg1.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: searchCall.id, content: promptText }] },
        ],
      }),
    })
    const msg2 = await res2.json()

    const events: Record<string, any> = {}
    for (const r of rows) events[r.id] = r
    const validIds = new Set(Object.keys(events))

    // Default: one untitled group of everything, if Claude's call is unusable.
    let lead = ''
    let groups: { label: string; event_ids: string[] }[] = []

    const presentCall = res2.ok && msg2.content?.find((b: any) => b.type === 'tool_use')
    if (presentCall?.input) {
      lead = typeof presentCall.input.lead === 'string' ? presentCall.input.lead : ''
      const seen = new Set<string>()
      groups = (presentCall.input.groups ?? [])
        .map((g: any) => ({
          label: String(g.label ?? '').trim(),
          // Keep only real IDs, no dupes across groups (first group wins).
          event_ids: (g.event_ids ?? []).filter((id: string) => {
            if (!validIds.has(id) || seen.has(id)) return false
            seen.add(id); return true
          }),
        }))
        .filter((g: any) => g.label && g.event_ids.length > 0)
    }

    return Response.json({ lead, groups, events })
  } catch (err) {
    console.error('search route error:', err)
    return Response.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}