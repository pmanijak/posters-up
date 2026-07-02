// app/api/chat/route.ts
//
// Search endpoint for the events feed. One fetch, one Claude call.
//
// Fetch the full upcoming set, hand it to Claude with the user's query, and let
// Claude do the one thing it's good at: read intent and group the events to
// answer it. A band name works because Claude sees the band in the set; a vibe
// ("date night") works because Claude reads the intent. Same path for both —
// no query parsing, no keyword heuristics, no substring matching.
//
// Returns JSON (not SSE): { lead, groups:[{label, event_ids}], events:{id: row} }.
// The client renders real EventCards from `events`; `groups` only carries
// label + ordering. Claude never sees or builds links — it groups by ID.
//
// Auth: SUPABASE_TELL_ME_MORE_KEY — needs event_sightings (not in any public view).

import { createClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import type { Database } from '@/lib/database.generated'
import {
  type EventRow, type TalentEntry, type Group,
} from '@/lib/types/events'
import { type EnrichmentData } from '@/lib/types/enrichment'

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const MODEL         = 'claude-haiku-4-5-20251001'

const supabase = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_TELL_ME_MORE_KEY!
)

// How far ahead the feed looks. Claude groups by date within this window
// ("this weekend", "next month") rather than the DB hard-filtering.
const WINDOW_DAYS = 60

// ── Anthropic API types ────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string
  name?: string
  [key: string]: unknown
}

interface PresentResultsInput {
  lead: string
  groups: unknown
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

// ── Tool ────────────────────────────────────────────────────────────────────

const PRESENT_TOOL = {
  name: 'present_results',
  description:
    'Organize the events for display. Write one short orienting line, then sort the ' +
    'events into a few plain-language groups so the user can land on what they want ' +
    'without scanning everything.',
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
          'across category (free, all-ages, outdoor, late-night, touring, this weekend). ' +
          'Use 1 group only if the set is genuinely uniform. Every event need not be ' +
          'placed — leftovers are shown under "More" automatically. When the user asks ' +
          'for a specific time ("this weekend") or vibe ("date night"), lead with the ' +
          'group that best answers them and leave clearly-unrelated events unplaced.',
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description: 'Plain, concrete, ≤3 words. e.g. "Free & outdoor", "All-ages shows", ' +
                '"Family workshops", "This weekend". Never vague ("Vibes", "Picks") — that reads as a machine.',
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

Your job is to INTERPRET the user's query and ORGANIZE the events you're given — not to \
narrate them. The user reads the real event cards; you sort them into useful piles and \
write one orienting line so they can land on what they want.

You are given a set of upcoming events and the user's query. Read the query for intent \
— a vibe ("something chill"), an occasion ("date night"), an audience ("good for kids"), \
a time ("this weekend", "next month"), or a concrete thing (a band, genre, venue). Then \
group the events to answer that intent. You are not filtering a database; you are a local \
who knows what's on and points the user at the right handful.

Grouping principles:
- Make groups that actually help someone decide: free, all-ages, outdoor, touring acts, this weekend, family-friendly — whatever the query and the set make relevant.
- 2–4 groups. One group only if the set is truly uniform. Labels must be plain and concrete — never "Vibes", "Picks", "Highlights".
- When the query names a time, vibe, or thing, lead with the group that answers it and leave clearly-unrelated events unplaced (they fall to "More" automatically). Don't force every event into a group.
- The lead line orients ("A couple of free outdoor things this weekend, plus a touring punk show"). It never says an event is good, never invents detail, never says anything is "worth your time". Any inference (touring, family-friendly) must be grounded in the event data shown.
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
      tools: [PRESENT_TOOL],
      tool_choice: { type: 'tool', name: 'present_results' },
      messages,
    }),
  })
  return { ok: res.ok, msg: await res.json() }
}

// ── Retrieval ────────────────────────────────────────────────────────────────
// Scoped to boards near the user, then filtered to the in-window set. Recurring
// / approximate / unknown always included regardless of date. No further limit
// — at current per-city corpus size the whole scoped set fits comfortably in
// context, and Claude needs to see everything to group well.
//
// Scoping matters even at single-city scale: events_public alone has no city
// or geo column (see ARCHITECTURE.md — city scaling is coordinate-based, not a
// schema column), so an unscoped query returns every active event system-wide.
// That's invisible today with one city live, but breaks silently the moment a
// second city exists — a Tacoma search would surface Olympia events with no
// way to tell they're not local. boardIds mirrors what the main feed
// (app/page.tsx) already resolves via boards_near() and passes to
// events_for_boards() — same scoping mechanism, reused here.

async function fetchUpcoming(boardIds: string[]): Promise<EventRow[]> {
  if (!boardIds.length) return []

  const { data, error } = await supabase.rpc('events_for_boards', { board_ids: boardIds })
  if (error) { console.error('events_for_boards error:', error); return [] }

  const today     = pacificDate(0)
  const windowEnd = pacificDate(WINDOW_DAYS)

  // events_for_boards returns SETOF events_public with no date filtering —
  // apply the same in-window logic here that the direct query used to do.
  const inWindow = (e: EventRow): boolean => {
    if (e.date_type !== 'specific') return true
    if (!e.date_start) return true
    if (e.date_start > windowEnd) return false
    return e.date_end ? e.date_end >= today : e.date_start >= today
  }

  return (data ?? [])
    .filter(inWindow)
    .sort((a, b) => {
      const da = a.date_start ?? '9999-99-99'
      const db = b.date_start ?? '9999-99-99'
      if (da !== db) return da.localeCompare(db)
      return (b.confidence_score ?? 0) - (a.confidence_score ?? 0)
    })
}

// ── Formatting ───────────────────────────────────────────────────────────────

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

// Fetch enrichment context (touring act, venue vibe) for a set of events.
async function fetchEnrichment(rows: EventRow[]): Promise<Map<string, EnrichmentData>> {
  const ids = rows.map(e => e.id).filter(Boolean) as string[]
  if (!ids.length) return new Map()

  const { data: sightings } = await supabase
    .from('event_sightings')
    .select('event_id, enrichment_data, sighted_at')
    .in('event_id', ids)
    .not('enrichment_data', 'is', null)
    .order('sighted_at', { ascending: false })

  const map = new Map<string, EnrichmentData>()
  for (const s of sightings ?? []) {
    if (!map.has(s.event_id)) map.set(s.event_id, s.enrichment_data as unknown as EnrichmentData)
  }
  return map
}

async function buildPromptText(rows: EventRow[], random: boolean): Promise<string> {
  if (!rows.length) return 'No events found.'
  const enrichmentMap = await fetchEnrichment(rows)
  const blocks = rows.map(e => formatForPrompt(e, enrichmentMap.get(e.id ?? '') ?? null, random))
  return `Found ${rows.length} events:\n\n${blocks.join('\n\n---\n\n')}`
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
  let query     = ''
  let city      = 'Olympia, WA'
  let boardIds: string[] = []
  try {
    const body = await req.json()
    query    = body.query ?? ''
    city     = body.city  ?? 'Olympia, WA'
    boardIds = Array.isArray(body.boardIds) ? body.boardIds.filter((id: unknown) => typeof id === 'string') : []
  } catch {}
  if (typeof query !== 'string') return Response.json({ error: 'Bad request' }, { status: 400 })

  const system      = systemPrompt(city)
  const userMessage = query || 'What is coming up?'
  const isRandom    = /surprise|anything|random/i.test(query)

  try {
    // No nearby boards (e.g. client hasn't resolved location yet) → nothing to
    // search. Matches the main feed's noBoardsNearby state rather than falling
    // back to an unscoped, system-wide query.
    let rows = await fetchUpcoming(boardIds)
    if (!rows.length) return Response.json({ lead: '', groups: [], events: {} })

    // Random / "surprise me": shuffle and take a few. Buzz signal suppressed
    // in formatForPrompt so surprise picks don't bias toward promoted events.
    if (isRandom) rows = shuffle(rows).slice(0, 3)

    const promptText = await buildPromptText(rows, isRandom)

    // The event block is cached (default 5-minute TTL) so back-to-back searches
    // don't reprocess ~40k tokens of event data — only the query is fresh input.
    // Cache hits require an identical prefix: same city, same date block,
    // unchanged event set (and not a random query, since those shuffle the block).
    // NOTE: at low traffic, gaps between searches will often exceed 5 minutes and
    // miss the cache entirely. The 1-hour TTL (ttl: '1h') trades a 2x write cost
    // for a much wider hit window — worth revisiting once there's usage data to
    // show how often searches land within 5 minutes of each other.
    const { ok, msg } = await callClaude([
      {
        role: 'user',
        content: [
          { type: 'text', text: promptText, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: userMessage },
        ],
      },
    ], system)

    const events: Record<string, EventRow> = {}
    for (const r of rows) {
      if (r.id) events[r.id] = r
    }
    const validIds = new Set(Object.keys(events))

    if (!ok || !msg.content) {
      console.error('present_results failed:', JSON.stringify(msg))
      // Degraded but useful: empty groups → everything renders under "More".
      return Response.json({ lead: '', groups: [], events })
    }

    const presentCall = msg.content.find(
      (b): b is PresentResultsBlock => b.type === 'tool_use' && b.name === 'present_results'
    )

    return Response.json({
      lead:   presentCall?.input.lead ?? '',
      groups: presentCall ? normalizeGroups(presentCall.input.groups, validIds) : [],
      events,
    })
  } catch (err) {
    console.error('search route error:', err)
    return Response.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}