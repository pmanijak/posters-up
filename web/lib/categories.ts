// lib/categories.ts

// Single source of truth: DB value → display label.
// EventCategory, the CATEGORIES array for the filter bar, and the search
// tool description are all derived from this — add a category here and
// everything updates automatically.
export const CATEGORY_MAP = {
  music:        'Music',
  film:         'Film',
  theater:      'Theater',
  dance:        'Dance',
  comedy:       'Comedy',
  spoken_word:  'Spoken Word',
  visual_art:   'Art',
  market:       'Market',
  workshop:     'Workshop',
  community:    'Community',
  party:        'Party',
  fundraiser:   'Fundraiser',
  other:        'Other',
} as const

export type EventCategory = keyof typeof CATEGORY_MAP

// UI sentinel — represents "no filter applied". Not a DB value.
// Consumers use ALL_CATEGORIES instead of the raw string 'all'.
export const ALL_CATEGORIES = 'all' as const
export type CategoryFilter = EventCategory | typeof ALL_CATEGORIES

// UI filter bar — ALL_CATEGORIES is first, DB values follow.
export const CATEGORIES: { value: CategoryFilter; label: string }[] = [
  { value: ALL_CATEGORIES, label: 'All' },
  ...Object.entries(CATEGORY_MAP).map(([value, label]) => ({
    value: value as EventCategory,
    label,
  })),
]

// lecture, fitness, support_group are valid DB values that can appear on event
// cards but are intentionally excluded from the filter bar.
type ExtendedCategory = EventCategory | 'lecture' | 'fitness' | 'support_group'

// Category colors live in globals.css as --cat-* vars (with a light-mode
// override block) so they can swap with prefers-color-scheme instead of being
// baked in as hex here. categoryColor() returns a var() reference, not a hex —
// it is only ever valid inside a CSS property (e.g. style={{ color: ... }}),
// never inside an SVG presentation attribute, since vars don't resolve there.
const CATEGORY_VARS: Record<ExtendedCategory, string> = {
  music:         'var(--cat-music)',
  film:          'var(--cat-film)',
  theater:       'var(--cat-theater)',
  dance:         'var(--cat-dance)',
  comedy:        'var(--cat-comedy)',
  spoken_word:   'var(--cat-spoken_word)',
  visual_art:    'var(--cat-visual_art)',
  market:        'var(--cat-market)',
  workshop:      'var(--cat-workshop)',
  community:     'var(--cat-community)',
  party:         'var(--cat-party)',
  fundraiser:    'var(--cat-fundraiser)',
  other:         'var(--cat-other)',
  lecture:       'var(--cat-lecture)',
  fitness:       'var(--cat-fitness)',
  support_group: 'var(--cat-support_group)',
}

const CATEGORY_COLOR_DEFAULT = 'var(--cat-default)'

export function categoryColor(category: string | null): string {
  return category
    ? (CATEGORY_VARS[category as ExtendedCategory] ?? CATEGORY_COLOR_DEFAULT)
    : CATEGORY_COLOR_DEFAULT
}