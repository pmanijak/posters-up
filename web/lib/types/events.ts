// lib/types/events.ts
import type { Database } from '@/lib/database.generated'
import type { EventCategory } from '@/lib/categories'

// The view is the public contract — EventRow is exactly what events_public exposes.
// To change what clients receive, change the view; don't maintain a parallel column list.
export type EventRow = Database['public']['Views']['events_public']['Row']

// talent is Json | null in EventRow (JSONB aggregate — shape unknown to the schema).
// TalentEntry is the hand-written shape of individual entries; cast at use sites.
export interface TalentEntry {
  name: string
  talent_type?: string
  role?: string
  billing_position?: number
}

export interface EnrichmentData {
  description?: string
  venue_context?: string
  [key: string]: unknown
}

export interface SearchInput {
  query?: string
  category?: EventCategory
  date_from?: string
  date_to?: string
  is_free?: boolean
  random?: boolean
}

export interface Group {
  label: string
  event_ids: string[]
}