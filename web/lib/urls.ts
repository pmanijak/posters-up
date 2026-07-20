// URL liveness policy.
// Used by event-card.tsx.

// check-urls stores the raw outcome of the last liveness check (a 3-digit
// HTTP status code as text, or 'timeout'/'unreachable') without judging
// which ones mean "broken" — see docs/check-urls_README.md. That judgment
// lives here, at the one place that renders the link:
//   - 404/410 are an explicit "this used to exist and doesn't anymore"
//   - 'unreachable' means no server ever answered (DNS/connection/TLS failure)
// Everything else (403, 429, 5xx, 'timeout', null/unchecked) is left
// clickable — those are as often bot-blocking or a slow/misconfigured
// server as an actually-dead link, and hiding a good link is worse than
// occasionally showing a bad one.
export function isConfirmedBrokenUrl(status: string | null | undefined): boolean {
  return status === '404' || status === '410' || status === 'unreachable'
}