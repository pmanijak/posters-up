import type { Database } from '@/lib/database.generated'
import type { EventCategory } from '@/lib/categories'

// The view is the public contract — EventRow is exactly what events_public exposes.
// To change what clients receive, change the view; don't maintain a parallel column list.
export type EventRow = Database['public']['Views']['events_public']['Row']

// talent is Json | null in EventRow (JSONB aggregate — shape unknown to the schema).
// TalentEntry is the typed shape of individual entries within the aggregate.
// Cast at use sites: (event.talent ?? []) as unknown as TalentEntry[]
//
// Fields mirror what events_public produces in jsonb_build_object:
//   id, name, talent_type, role, billing_position
//
// confirmed is in event_talent but not yet in the events_public talent aggregate.
// TODO: add `et.confirmed` to the view's jsonb_build_object and regenerate types.
// Until then, confirmed will be undefined for all entries; the enrichment gate in
// EventCard degrades gracefully — talent names still render, links and bios are
// suppressed (confirmedTalentNames stays empty).
export interface TalentEntry {
  id:               string
  name:             string
  talent_type:      string | null
  role:             string | null
  billing_position: number | null
  confirmed?:       boolean
}

// EnrichmentData lives in lib/types/enrichment.ts — import from there directly.

export interface SearchInput {
  query?:     string
  category?:  EventCategory
  date_from?: string
  date_to?:   string
  is_free?:   boolean
  random?:    boolean
}

export interface Group {
  label:     string
  event_ids: string[]
}