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

// Two-tier window: most searches don't need 60 days of events, so default narrow
// and only pay for the wider (and pricier) fetch when the narrow set is thin —
// same fallback shape already used for the ilike-empty and embed-fail cases
// elsewhere in this codebase, rather than trying to keyword-detect "this query
// implies a future date" (fragile, and this project already moved away from
// that pattern once — see VIBE_HINTS in the search architecture history).
const NARROW_WINDOW_DAYS = 14
const WIDE_WINDOW_DAYS   = 60

// Below this row count, the narrow window is assumed too thin to group well —
// widen and refetch. Placeholder threshold; tune once search_queries logging
// (see handoff.md Next) shows real row-count distributions per query.
const MIN_ROWS_BEFORE_WIDENING = 15

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

This is a single, non-interactive call — there is no follow-up turn. Never use the lead \
line to ask the user a clarifying question ("What are you in the mood for?") or to comment \
on the size of the set ("That's a lot of events!"). Even with a large or loosely-matching \
set, make your best judgment call and group it — an imperfect grouping is always better \
than punting the question back. If the query is broad or vague ("what's coming up"), treat \
it as "show me the highlights" and group by whatever dimensions are most useful (this \
weekend, free, touring acts, etc.) rather than asking what the user wants.

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

async function fetchUpcoming(boardIds: string[], windowDays: number): Promise<EventRow[]> {
  if (!boardIds.length) return []

  const { data, error } = await supabase.rpc('events_for_boards', { board_ids: boardIds })
  if (error) { console.error('events_for_boards error:', error); return [] }

  const today     = pacificDate(0)
  const windowEnd = pacificDate(windowDays)

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

// Enrichment paragraphs can run 100+ words — plenty for the "Tell me more" card,
// way more than grouping needs. Truncate to a clause, not a summary: enough for
// Claude to tell "punk feminist icon" from "senior ballroom dance."
const ENRICHMENT_CONTEXT_MAX_CHARS = 300
const DESCRIPTION_MAX_CHARS        = 150

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  // Cut at the last word boundary before the limit so it doesn't end mid-word.
  const cut = text.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
}

// A `field: ` label repeated across ~400 events is pure overhead — Claude doesn't
// need "Category:" to recognize a category. One delimited line per event carries
// the same information with a fraction of the tokens; the column order is
// documented once in PROMPT_FIELD_HEADER instead of 400 times. Empty fields are
// left blank between delimiters rather than omitted, so column position stays
// fixed and unambiguous.
const FIELD_SEP = ' | '

const PROMPT_FIELD_HEADER =
  'Each event is one line: id | name | category | date | location | featuring | ' +
  'price | flags | description\n' +
  '(flags: any of "free", "outdoor", "N+" for age restriction, "Nx" for board sighting count ≥3 — space-separated, may be empty)'

function formatForPrompt(e: EventRow, enrichment: EnrichmentData | null, random: boolean): string {
  // id and name are non-null at runtime; nullable in the type because Postgres
  // can't infer NOT NULL through views.
  const id       = e.id ?? ''
  const name     = e.name ?? ''
  const category = e.event_category ?? ''

  let date = ''
  if (e.date_type === 'specific' && e.date_start) {
    const [y, m, d] = e.date_start.split('-').map(Number)
    date = new Date(y, m - 1, d).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
    })
  } else if (e.date_raw) {
    date = e.date_raw
  } else if (e.date_type === 'recurring') {
    date = 'recurring'
  }

  const location = e.location_name ?? ''

  // talent is Json | null in the generated type (JSONB aggregate); cast to known shape.
  const talents  = Array.isArray(e.talent) ? e.talent as unknown as TalentEntry[] : []
  const featuring = talents.map(t => t.name).join(', ')

  const price = e.price_raw ?? (e.is_free ? 'free' : '')

  const flags: string[] = []
  if (e.is_free && !e.price_raw) flags.push('free')
  if (e.is_outdoor === true) flags.push('outdoor')
  if (e.age_restriction) flags.push(e.age_restriction)
  // Buzz: suppressed for random queries so surprise picks don't bias to promoted.
  if (!random && (e.sighting_count ?? 0) >= 3) flags.push(`${e.sighting_count}x`)

  // Description + enrichment context combined into one truncated field —
  // grouping needs a clause of signal per source, not the full narrative.
  // Full text still lives in enrichment_data for the "Tell me more" card.
  const descParts: string[] = []
  if (e.description) descParts.push(truncate(e.description, DESCRIPTION_MAX_CHARS))
  if (enrichment?.description) descParts.push(truncate(enrichment.description, ENRICHMENT_CONTEXT_MAX_CHARS))
  const description = descParts.join(' — ')

  // Tags omitted — mostly redundant with category + description for grouping,
  // and some lists run 8-10 items. Still shown on the card.

  return [id, name, category, date, location, featuring, price, flags.join(' '), description].join(FIELD_SEP)
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
  const lines = rows.map(e => formatForPrompt(e, enrichmentMap.get(e.id ?? '') ?? null, random))
  return `Found ${rows.length} events. ${PROMPT_FIELD_HEADER}\n\n${lines.join('\n')}`
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
    // Random queries go straight to the wide window — a 3-event surprise pick
    // should draw from the full pool, not just the next two weeks.
    let rows = await fetchUpcoming(boardIds, isRandom ? WIDE_WINDOW_DAYS : NARROW_WINDOW_DAYS)

    // Narrow set came back thin (e.g. "next month", a slow week, or genuinely
    // few events near this user) — widen and refetch rather than handing Claude
    // too little to group well. Mirrors the ilike-empty and embed-fail fallback
    // pattern used elsewhere in this route's history.
    if (!isRandom && rows.length < MIN_ROWS_BEFORE_WIDENING) {
      rows = await fetchUpcoming(boardIds, WIDE_WINDOW_DAYS)
    }

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
    //
    // The query is explicitly labeled ("User query:") rather than appended as a
    // bare, unmarked second text block. With a large event list (up to ~350+
    // rows when dateless/recurring events bypass the window filter — see
    // fetchUpcoming), an unlabeled 3-5 word instruction tacked onto the end of a
    // long data dump is easy for the model to under-weight relative to the data
    // that precedes it. Labeling it removes the ambiguity outright rather than
    // relying on positional emphasis.
    const { ok, msg } = await callClaude([
      {
        role: 'user',
        content: [
          { type: 'text', text: promptText, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: `User query: "${userMessage}"` },
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