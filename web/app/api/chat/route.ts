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
import type { Database } from '@/lib/database.generated'
import { CATEGORY_MAP } from '@/lib/categories'
import {
  type EventRow, type TalentEntry,
  type SearchInput, type Group,
} from '@/lib/types/events'
import { type EnrichmentData } from '@/lib/types/enrichment'

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const MODEL         = 'claude-haiku-4-5-20251001'

const supabase = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_TELL_ME_MORE_KEY!
)

// Derived from CATEGORY_MAP — updates automatically when categories change.
const EVENT_CATEGORY_VALUES = Object.keys(CATEGORY_MAP).join(', ')

// ── Anthropic API types ────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string
  name?: string
  [key: string]: unknown
}

// Per-tool input shapes. input is typed specifically so no casts are needed
// at the call sites. groups stays unknown — validated at runtime by normalizeGroups.
interface PresentResultsInput {
  lead: string
  groups: unknown
}

interface SearchEventsBlock extends AnthropicContentBlock {
  type: 'tool_use'
  name: 'search_events'
  id: string
  input: SearchInput
}

interface PresentResultsBlock extends AnthropicContentBlock {
  type: 'tool_use'
  name: 'present_results'
  id: string
  input: PresentResultsInput
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[]
}

// ── Date helpers ───────────────────────────────────────────────────────────

function pacificDate(offsetDays = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })
    .format(new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000))
}

// ── Tools ──────────────────────────────────────────────────────────────────

const SEARCH_TOOL = {
  name: 'search_events',
  description:
    'Search events spotted on local bulletin boards. Always call before answering.',
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
          `${EVENT_CATEGORY_VALUES}. ` +
          'Only set this when the user explicitly names a content type ("jazz show", ' +
          '"film screening", "workshop"). Do NOT infer category from audience or occasion — ' +
          '"for kids", "family", "date night" are NOT categories.',
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

// ── System prompt ──────────────────────────────────────────────────────────
//
// Static block is cached (cache_control: ephemeral) — its text must be
// identical across requests. Per-request context (today's date, city) lives
// in the second block so the static block stays cacheable regardless of city.

const SYSTEM_PROMPT_STATIC = `You organize a local events feed for Posters Up (postersup.org), \
which discovers events from physical bulletin boards around your city.

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

function systemPrompt(city: string) {
  return [
    { type: 'text', text: SYSTEM_PROMPT_STATIC, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `Today is ${pacificDate(0)}. City: ${city}.` },
  ]
}

// ── Anthropic client ───────────────────────────────────────────────────────

function claudeHeaders() {
  return {
    'Content-Type':      'application/json',
    'x-api-key':         process.env.ANTHROPIC_CHAT_API_KEY!,
    'anthropic-version': '2023-06-01',
  }
}

async function callClaude(
  toolName: string,
  messages: unknown[],
  system: ReturnType<typeof systemPrompt>
): Promise<{ ok: boolean; msg: AnthropicResponse }> {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: claudeHeaders(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: [SEARCH_TOOL, PRESENT_TOOL],
      tool_choice: { type: 'tool', name: toolName },
      messages,
    }),
  })
  return { ok: res.ok, msg: await res.json() }
}

// ── Tool execution ─────────────────────────────────────────────────────────
// Returns the full rows (for the client to render as cards) plus a compact
// text block (for Claude to reason over and group by ID).

function shuffle<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function formatForPrompt(e: EventRow, enrichment: EnrichmentData | null, random: boolean): string {
  // id and name are non-null at runtime; nullable in the type because Postgres
  // can't infer NOT NULL through views.
  const lines: string[] = [`ID: ${e.id ?? ''}`, `Name: ${e.name ?? ''}`]

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

  // talent is Json | null in the generated type (JSONB aggregate); cast to known shape.
  const talents = Array.isArray(e.talent) ? e.talent as unknown as TalentEntry[] : []
  if (talents.length) lines.push(`Featuring: ${talents.map(t => t.name).join(', ')}`)

  if (e.price_raw)    lines.push(`Price: ${e.price_raw}`)
  else if (e.is_free) lines.push('Price: Free')
  if (e.age_restriction) lines.push(`Ages: ${e.age_restriction}`)
  if (e.is_outdoor === true) lines.push('Outdoor')
  if (e.description) lines.push(`Description: ${e.description}`)
  if (enrichment?.description) lines.push(`Context: ${enrichment.description}`)
  if (enrichment?.venue_context) lines.push(`Venue: ${enrichment.venue_context}`)
  if (e.tags?.length) lines.push(`Tags: ${e.tags.join(', ')}`)

  // Buzz: suppressed for random queries so surprise picks don't bias to promoted.
  if (!random && (e.sighting_count ?? 0) >= 3) {
    lines.push(`Buzz: on ${e.sighting_count} boards around town`)
  }

  return lines.join('\n')
}

async function executeSearch(input: SearchInput): Promise<{ rows: EventRow[]; promptText: string }> {
  const today     = pacificDate(0)
  const windowEnd = input.date_to ?? pacificDate(30)

  let q = supabase
    .from('events_public')
    .select('*')
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

  let rows: EventRow[] = events
  if (input.random) {
    rows = shuffle(rows).slice(0, 3)
  }

  // Enrichment for grouping context (touring act, venue vibe) — fetched once.
  const ids = rows.map(e => e.id).filter(Boolean) as string[]
  const { data: sightings } = await supabase
    .from('event_sightings')
    .select('event_id, enrichment_data, sighted_at')
    .in('event_id', ids)
    .not('enrichment_data', 'is', null)
    .order('sighted_at', { ascending: false })

  const enrichmentMap = new Map<string, EnrichmentData>()
  for (const s of sightings ?? []) {
    if (!enrichmentMap.has(s.event_id)) enrichmentMap.set(s.event_id, s.enrichment_data as unknown as EnrichmentData)
  }

  const blocks = rows.map(e => formatForPrompt(e, enrichmentMap.get(e.id ?? '') ?? null, !!input.random))
  return { rows, promptText: `Found ${rows.length} events:\n\n${blocks.join('\n\n---\n\n')}` }
}

// ── Group normalization ────────────────────────────────────────────────────
// Validates and deduplicates Claude's present_results output. IDs not in
// validIds are dropped (hallucinations); first group wins on duplicates.

function normalizeGroups(rawGroups: unknown, validIds: Set<string>): Group[] {
  if (!Array.isArray(rawGroups)) return []
  const seen = new Set<string>()
  return rawGroups
    .map((g: unknown) => {
      const group = g as Record<string, unknown>
      return {
        label: String(group.label ?? '').trim(),
        // Keep only real IDs, no dupes across groups (first group wins).
        event_ids: (Array.isArray(group.event_ids) ? group.event_ids : []).filter((id: unknown) => {
          if (typeof id !== 'string' || !validIds.has(id) || seen.has(id)) return false
          seen.add(id); return true
        }),
      }
    })
    .filter((g): g is Group => Boolean(g.label) && g.event_ids.length > 0)
}

// ── Route ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let query = ''
  let city  = 'Olympia, WA'
  try {
    const body = await req.json()
    query = body.query ?? ''
    city  = body.city  ?? 'Olympia, WA'
  } catch {}
  if (typeof query !== 'string') return Response.json({ error: 'Bad request' }, { status: 400 })

  const system       = systemPrompt(city)  // compute once per request
  const baseMessages = [{ role: 'user', content: query || 'What is coming up?' }]

  try {
    // Step 1 — forced search_events
    const { ok: ok1, msg: msg1 } = await callClaude('search_events', baseMessages, system)
    if (!ok1) return Response.json({ error: 'Search failed.' }, { status: 502 })

    const searchCall = msg1.content?.find((b): b is SearchEventsBlock => b.type === 'tool_use' && b.name === 'search_events')
    if (!searchCall) return Response.json({ lead: '', groups: [], events: {} })

    const searchInput = searchCall.input
    let { rows, promptText } = await executeSearch(searchInput)

    // If Claude passed a literal query and got nothing back, it probably used a vibe
    // phrase instead of a flyer token. Retry without the query — let present_results
    // do the concept matching instead. All other filters (date, is_free, category) are
    // preserved so the retry is still appropriately scoped.
    if (!rows.length && searchInput.query) {
      ;({ rows, promptText } = await executeSearch({ ...searchInput, query: undefined }))
    }

    if (!rows.length) return Response.json({ lead: '', groups: [], events: {} })

    // Step 2 — forced present_results
    const { ok: ok2, msg: msg2 } = await callClaude('present_results', [
      ...baseMessages,
      { role: 'assistant', content: msg1.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: searchCall.id, content: promptText }] },
    ], system)
    if (!ok2 || !msg2.content) {
      console.error('present_results failed:', JSON.stringify(msg2))
      // Fall through — groups stays empty, leftovers render under "More"
    }

    const events: Record<string, EventRow> = {}
    for (const r of rows) {
      if (r.id) events[r.id] = r
    }
    const validIds = new Set(Object.keys(events))

    // Default: empty groups — leftovers render under "More" automatically.
    let lead   = ''
    let groups: Group[] = []

    const presentCall = ok2
      ? msg2.content?.find((b): b is PresentResultsBlock => b.type === 'tool_use' && b.name === 'present_results')
      : undefined
    if (presentCall) {
      lead   = presentCall.input.lead
      groups = normalizeGroups(presentCall.input.groups, validIds)
    }

    return Response.json({ lead, groups, events })
  } catch (err) {
    console.error('search route error:', err)
    return Response.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}