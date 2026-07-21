// Render-time typing for events.contact.
//
// `contact` is polymorphic — the extraction pipeline writes whatever
// public-facing contact the flyer showed, and across the corpus that's
// at least four different shapes:
//
//   website  "thecarpenters.house", "https://harlequinproductions.org"
//   email    "hello@thecarpenters.house"
//   phone    "(360) 555-0142"
//   handle   "@thebrotherhood"
//
// The card previously treated all of these as a URL and prefixed
// "https://", which produced dead links like "https://@thebrotherhood".
//
// This module only classifies and formats. It never mutates the stored
// value — consistent with the pipeline principle that `events` holds
// what the flyer says.
//
// Display policy (see ARCHITECTURE.md §5):
//   website — linked out, scheme added if missing
//   handle  — plain text, NEVER linked. A bare "@name" doesn't say which
//             platform it belongs to (the flyer's platform glyph is lost
//             by extraction time), and guessing sends people to a
//             stranger's profile on the wrong network.
//   email   — hidden
//   phone   — hidden
//
// NOTE: hiding email/phone here is presentation-only. `events` has a
// public read policy, so these values are still in the API response.
// Keeping personal contacts out of the column at extraction time is the
// actual privacy control; this only stops them being rendered and
// scraped off the page.

export type ContactKind = "website" | "email" | "phone" | "handle" | "unknown";

export interface ClassifiedContact {
  kind: ContactKind;
  /** The value as stored, unchanged. */
  raw: string;
  /** Text to show, or null if this kind is not displayed. */
  display: string | null;
  /** href to link to, or null if this kind should not be a link. */
  href: string | null;
}

// Loose enough to catch what flyers actually print. Not a validator —
// we only need to tell these four shapes apart from each other.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Starts with @ and has no dot after it — an unqualified social handle.
// "@thebrotherhood" matches; "hello@carpenters.house" does not (caught
// by EMAIL_RE first anyway).
const HANDLE_RE = /^@[A-Za-z0-9._-]+$/;

// 7+ digits once separators are stripped, and nothing that looks like a
// domain. Deliberately checked AFTER email/handle so "@1234" doesn't
// slip through as a phone number.
const PHONE_CHARS_RE = /^[\d\s().+\-x]+$/i;

// One or more dot-separated labels, optional path/query. Matches both
// "thecarpenters.house" and "loveolydowntown.com/events/foo".
const BARE_HOST_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/.*)?$/i;

function hasScheme(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function countDigits(value: string): number {
  return (value.match(/\d/g) ?? []).length;
}

export function classifyContact(value: string | null | undefined): ClassifiedContact | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;

  // Order matters: email before phone (an email has no digit floor but
  // could contain digits), handle before phone (see PHONE_CHARS_RE note).
  if (EMAIL_RE.test(raw)) {
    return { kind: "email", raw, display: null, href: null };
  }

  if (HANDLE_RE.test(raw)) {
    // Shown without linking. Keep the leading @ — it's how the flyer
    // wrote it and it signals "look this up" without implying a target.
    return { kind: "handle", raw, display: raw, href: null };
  }

  if (PHONE_CHARS_RE.test(raw) && countDigits(raw) >= 7) {
    return { kind: "phone", raw, display: null, href: null };
  }

  if (hasScheme(raw)) {
    return { kind: "website", raw, display: stripScheme(raw), href: raw };
  }

  if (BARE_HOST_RE.test(raw)) {
    // Scheme added for the link target only; `raw` is untouched. Flyers
    // routinely print bare domains and that's normal, not malformed.
    return { kind: "website", raw, display: raw, href: `https://${raw}` };
  }

  // Doesn't match any known shape — don't guess, don't link, don't show.
  // This is the bucket that would previously have become a broken link.
  return { kind: "unknown", raw, display: null, href: null };
}

/** "https://www.example.com/path" -> "www.example.com/path" */
function stripScheme(value: string): string {
  return value.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** True if this contact produces anything visible on the card. */
export function isDisplayableContact(value: string | null | undefined): boolean {
  const c = classifyContact(value);
  return c !== null && c.display !== null;
}