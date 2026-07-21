import { classifyContact } from '@/lib/contact'

interface EventContactProps {
  contact: string | null | undefined
  className?: string
}

/**
 * Renders events.contact according to its detected shape.
 *
 * Websites link out. Social handles render as unlinked mono text — a bare
 * "@name" doesn't identify a platform (the flyer's platform glyph is lost by
 * extraction time), and guessing sends people to a stranger's profile on the
 * wrong network. Emails and phone numbers render nothing. Unrecognized shapes
 * render nothing rather than being guessed into a link — that's the bucket
 * that previously became `https://@thebrotherhood`.
 *
 * Returns null when there's nothing displayable, so callers should gate any
 * surrounding label or row on isDisplayableContact() rather than assuming
 * this always produces output.
 *
 * Deliberately carries no explanatory copy — the caller supplies the label.
 */
export function EventContact({ contact, className }: EventContactProps) {
  const classified = classifyContact(contact)
  if (!classified || !classified.display) return null

  if (classified.href) {
    return (
      <a
        href={classified.href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {classified.display} →
      </a>
    )
  }

  // Handle — shown, not linked. Mono because it's an identifier to be
  // retyped into a search box, not prose to be read.
  return (
    <span className={`font-mono ${className ?? ''}`}>
      {classified.display}
    </span>
  )
}