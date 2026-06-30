import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import type { Database } from '@/lib/database.generated'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabaseAdmin = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_TELL_ME_MORE_KEY!
  )

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const token = authHeader.replace('Bearer ', '')
  const { data: { user } } = await supabaseAdmin.auth.getUser(token)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify photo exists and belongs to this user
  const { data: photo } = await supabaseAdmin
    .from('photos')
    .select('id, extraction_status, extraction_error, submitted_by')
    .eq('id', id)
    .single()

  if (!photo) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (photo.submitted_by !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const result: Record<string, unknown> = {
    extraction_status: photo.extraction_status,
  }

  if (photo.extraction_status === 'failed') {
    result.extraction_error = photo.extraction_error
  }

  // Always return whatever sightings exist so far — not just when complete.
  // This lets the upload page show items as they arrive during extraction.
  const { data: sightings } = await supabaseAdmin
    .from('event_sightings')
    .select(`
      id,
      match_type,
      extraction_confidence,
      flyer_style,
      raw_extraction,
      events (
        id,
        name,
        date_start,
        confidence_score
      )
    `)
    .eq('photo_id', id)
    .order('created_at', { ascending: true })

  result.sightings = sightings ?? []

  return NextResponse.json(result)
}