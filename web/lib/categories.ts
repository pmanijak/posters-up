// app/lib/categories.ts
// Shared category definitions used by FilterBar and EventCard.

export const CATEGORIES = [
  { value: 'all',           label: 'All' },
  { value: 'music',         label: 'Music' },
  { value: 'film',          label: 'Film' },
  { value: 'theater',       label: 'Theater' },
  { value: 'dance',         label: 'Dance' },
  { value: 'comedy',        label: 'Comedy' },
  { value: 'spoken_word',   label: 'Spoken Word' },
  { value: 'visual_art',    label: 'Art' },
  { value: 'market',        label: 'Market' },
  { value: 'workshop',      label: 'Workshop' },
  { value: 'community',     label: 'Community' },
  { value: 'fundraiser',    label: 'Fundraiser' },
  { value: 'other',         label: 'Other' },
]

export const CATEGORY_COLORS: Record<string, string> = {
  music:         '#D4956A',  // warm amber
  film:          '#7A9EC4',  // slate blue
  theater:       '#B48AC4',  // muted purple
  dance:         '#7ABDB4',  // teal
  comedy:        '#D4B86A',  // golden
  spoken_word:   '#9AB47A',  // sage
  visual_art:    '#C48AAA',  // dusty rose
  market:        '#C4AA7A',  // tan
  lecture:       '#7A9EB4',  // steel blue
  workshop:      '#C4956A',  // terracotta
  fitness:       '#7AC49A',  // mint
  community:     '#7AAAC4',  // sky
  support_group: '#A49AC4',  // lavender
  fundraiser:    '#C4A07A',  // sand
  party:         '#D4B86A',  // golden
}

export function categoryColor(category: string | null): string {
  return category ? (CATEGORY_COLORS[category] ?? '#8A9E8F') : '#8A9E8F'
}

export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}