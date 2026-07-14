// lib/utils/color.ts

// Takes any CSS color -- including a var() reference, which is what
// categoryColor() returns -- and composites it at the given alpha against
// transparent. Replaces the old hexToRgba(), which broke once category
// colors moved from hex literals to CSS vars (a var() string can't be
// parsed as hex).
export function withAlpha(color: string, alpha: number): string {
  return `color-mix(in oklab, ${color} ${alpha * 100}%, transparent)`
}