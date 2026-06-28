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

export const CATEGORY_COLORS: Record<ExtendedCategory, string> = {
  music:         '#D4956A',  // warm amber
  film:          '#7A9EC4',  // slate blue
  theater:       '#B48AC4',  // muted purple
  dance:         '#7ABDB4',  // teal
  comedy:        '#D4B86A',  // golden
  spoken_word:   '#9AB47A',  // sage
  visual_art:    '#C48AAA',  // dusty rose
  market:        '#C4AA7A',  // tan
  workshop:      '#C4956A',  // terracotta
  community:     '#7AAAC4',  // sky
  party:         '#D4B86A',  // golden
  fundraiser:    '#C4A07A',  // sand
  other:         '#8A9E8F',  // muted green
  lecture:       '#7A9EB4',  // steel blue
  fitness:       '#7AC49A',  // mint
  support_group: '#A49AC4',  // lavender
}

const CATEGORY_COLOR_DEFAULT = '#8A9E8F'

export function categoryColor(category: string | null): string {
  return category
    ? (CATEGORY_COLORS[category as ExtendedCategory] ?? CATEGORY_COLOR_DEFAULT)
    : CATEGORY_COLOR_DEFAULT
}