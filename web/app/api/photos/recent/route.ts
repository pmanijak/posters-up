import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import type { Database } from '@/lib/database.generated'

// Service-role client — this route is the server-side boundary that lets an
// authenticated user see their own recent photos without granting SELECT on
// the base `photos` table to the `authenticated` role. Per ARCHITECTURE.md's
// access control table, `authenticated` only has INSERT on `photos`; reads
// go through routes like this one (or public views), never the base table
// directly.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_TELL_ME_MORE_KEY = process.env.SUPABASE_TELL_ME_MORE_KEY!

// How far back this looks for a contributor's own photos, regardless of
// status. Mirrors RESUME_WINDOW_HOURS in app/upload/page.tsx — bounds this to
// a plausible single session rather than a user's entire upload history.
// Kept here rather than accepted from the client so the window can't be
// widened by a crafted request; if this ever needs to change, update it here
// and in app/upload/page.tsx together.
const RESUME_WINDOW_HOURS = 2

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_TELL_ME_MORE_KEY)
  const token = authHeader.replace('Bearer ', '')

  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const defaultSince = new Date(Date.now() - RESUME_WINDOW_HOURS * 60 * 60 * 1000)

  // ?after lets the client narrow the window further (e.g. "don't show me
  // anything from before my last explicit reset") — but never widen it past
  // RESUME_WINDOW_HOURS. Anything unparseable is ignored rather than trusted.
  const afterParam = req.nextUrl.searchParams.get('after')
  const afterDate = afterParam ? new Date(afterParam) : null
  const since = (afterDate && !isNaN(afterDate.getTime()) && afterDate > defaultSince
    ? afterDate
    : defaultSince
  ).toISOString()

  const { data, error } = await supabase
    .from('photos')
    .select('id, image_url, board_id, extraction_status, extraction_error, submitted_at, processing_started_at')
    .eq('submitted_by', user.id)
    .gte('submitted_at', since)
    .order('submitted_at', { ascending: true })

  if (error) {
    console.error('GET /api/photos/recent failed:', error)
    return NextResponse.json({ error: 'Failed to load recent photos' }, { status: 500 })
  }

  return NextResponse.json({ photos: data ?? [] })
}