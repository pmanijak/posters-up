export function DisclaimerCard() {
  return (
    <div className="rounded-sm border border-dashed border-edge p-4 space-y-2">
      <p className="text-xs font-mono tracking-wider uppercase text-content-muted">A note on accuracy</p>
      <p className="text-sm leading-relaxed text-content-secondary">
        These events come from photos of posters on the street, which can have glare, rips,
        be partially covered, or just plain hard to read. Double-check the details before you make your plans.
      </p>
    </div>
  )
}