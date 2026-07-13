// app/api/contact/route.ts
//
// Server-side gate in front of contact_messages. anon already has an
// INSERT policy on the table (see migration), so this route isn't the
// only path to the data — it's here for bot filtering before a message
// ever hits the DB. No IP or fingerprint is stored: that would cut
// against the app's "minimal contributor data" posture (see
// ARCHITECTURE.md's Privacy Decisions). A honeypot field plus a
// minimum-time-on-page check catches most non-targeted bot traffic
// without collecting anything about the sender.
//
// If real spam volume shows up later, the next lever is a Postgres
// function that rate-limits by a *hashed* IP (never raw), same spirit
// as max_daily_submissions_per_user — not built now because there's
// no evidence it's needed yet.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase'

const CATEGORIES = ['bug', 'wrong_info', 'takedown', 'feedback', 'other'] as const
type Category = (typeof CATEGORIES)[number]

const MIN_SECONDS_ON_PAGE = 3 // faster than this on a fresh page load reads as scripted

export async function POST(req: NextRequest) {
  let body: {
    email?: string
    category?: string
    message?: string
    context_url?: string
    event_id?: string
    // honeypot — real users never see or fill this field; CSS-hide it in the form
    company?: string
    // timestamp (ms) the form was rendered, echoed back by the client
    renderedAt?: number
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  // Honeypot tripped — pretend success, don't tell the bot why it failed.
  if (body.company) {
    return NextResponse.json({ ok: true })
  }

  // Submitted implausibly fast for a human reading and typing.
  if (body.renderedAt && Date.now() - body.renderedAt < MIN_SECONDS_ON_PAGE * 1000) {
    return NextResponse.json({ ok: true })
  }

  const message = body.message?.trim()
  if (!message) {
    return NextResponse.json({ error: 'Message is required' }, { status: 400 })
  }
  if (message.length > 5000) {
    return NextResponse.json({ error: 'Message is too long' }, { status: 400 })
  }

  const category: Category = CATEGORIES.includes(body.category as Category)
    ? (body.category as Category)
    : 'other'

  // Publishable key is sufficient — RLS INSERT policy on contact_messages
  // allows this; no service-role key needed, no read-back happens here.
  // Reuses the same client helper the rest of the app uses (lib/supabase.ts),
  // so it's typed against Database and picks up NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
  // rather than a key name this route would otherwise have invented on its own.
  const supabase = createClient()

  const { error } = await supabase.from('contact_messages').insert({
    email: body.email?.trim() || null,
    category,
    message,
    context_url: body.context_url || null,
    event_id: body.event_id || null,
  })

  if (error) {
    console.error('contact_messages insert failed:', error)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}