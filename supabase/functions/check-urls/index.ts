// check-urls — cron liveness check for events.event_url / events.rsvp_url.
//
// Flyer photos get OCR'd into event_url/rsvp_url, and misreads (1/l, 0/O,
// dropped path segments) produce plausible-looking but dead links. This
// function flags them so the presentation layer can hide or relabel a
// broken link instead of sending people to a 404.
//
// Deliberately NOT part of `enrich`:
//   - enrich's queue (fetchEventsNeedingEnrichment) only picks up events
//     missing a field or under 0.7 confidence. A well-extracted event
//     with everything else intact but a bad event_url would never enter
//     that queue, so it would never get checked.
//   - This check is a plain HTTP HEAD/GET with no LLM call, so it doesn't
//     need enrich's cost/latency budget or its web-search allotment —
//     it runs against `events` directly, independent of enrichment state.
//
// Design principle (same as enrich): events holds what the flyer says.
// This function never rewrites event_url/rsvp_url — it only annotates
// them with a status. A misread URL stays exactly as extracted; it's
// just flagged with what checking it actually returned.
//
// Status semantics (event_url_status / rsvp_url_status):
//   null        — unchecked, or not applicable (rsvp_url is an email, not
//                 a URL; event_url doesn't parse as a checkable host at all)
//   '200'..'599' — the final HTTP status code, as text, after following redirects
//   'timeout'   — request did not complete within FETCH_TIMEOUT_MS
//   'unreachable' — DNS failure, connection refused, TLS failure (no HTTP
//                   response was ever received)
// The raw code is stored as-is; this function does not judge which codes
// mean "broken" — a 403 or 429 is as often bot-blocking (Facebook and
// Eventbrite both do this to non-browser requests) as an actually-dead
// page, and that call belongs to whoever renders the link, not the check.
//
// Scheme handling: flyers routinely print bare domains ("thecarpenters.house")
// with no "https://" — that's normal OCR output, not a malformed value.
// normalizeForCheck() adds a scheme for the outbound request only; the
// stored event_url/rsvp_url is never rewritten. Values that don't even
// look like a host (e.g. a bare "@handle") are left unchecked and the
// field is still stamped as checked-but-not-applicable, the same way a
// non-URL rsvp_url (an email address) already was — otherwise the queue
// query re-selects them every run forever, since a null *_checked_at is
// exactly what it selects on.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Keep well within the function timeout: N events * up to ~2 fetches each
// (HEAD, then GET fallback) * per-request timeout.
const MAX_EVENTS_PER_RUN = 50;
const FETCH_TIMEOUT_MS = 8_000;

// Looks like a browser so we don't get reflexively 403'd by bot filters
// that would otherwise pollute the "dead" signal.
const USER_AGENT =
  "Mozilla/5.0 (compatible; PostersUpLinkCheck/1.0; +https://postersup.org)";

interface EventRow {
  id: string;
  event_url: string | null;
  rsvp_url: string | null;
}

// ---------------------------------------------------------------------------
// URL liveness check
// ---------------------------------------------------------------------------

function isHttpUrl(value: string | null): value is string {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Bare-host shape: one or more dot-separated labels, optionally followed
// by a path/query. Matches what a flyer would plausibly print without a
// scheme ("thecarpenters.house", "www.slug-love.com/tickets"). Does NOT
// match a single label with no dot (e.g. "@thebrotherhood", "thebrotherhood")
// — those aren't hosts, they're handles or garbage, and should fall through
// to "not applicable" rather than be guessed at.
const BARE_HOST_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/.*)?$/i;

// Returns the URL to actually request, or null if the value isn't
// checkable at all (not a URL, and doesn't look like a bare host either —
// e.g. an @handle, or garbage OCR output). Never mutates or returns
// anything that gets written back to event_url/rsvp_url — this is
// strictly the outbound request target.
function normalizeForCheck(value: string | null): string | null {
  if (!value) return null;
  if (isHttpUrl(value)) return value;
  if (BARE_HOST_RE.test(value)) return `https://${value}`;
  return null;
}

// Returns the outcome of checking a URL, as the exact string that gets
// written to event_url_status/rsvp_url_status. See module comment for
// the full semantics of the possible return values.
async function checkUrl(url: string): Promise<string> {
  const attempt = async (method: "HEAD" | "GET"): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    let res = await attempt("HEAD");
    // Some servers don't implement HEAD correctly (405), or block it
    // outright (403) in a way a real GET would clear — retry with GET
    // before recording a final code.
    if (res.status === 405 || res.status === 403) {
      res = await attempt("GET");
    }
    return String(res.status);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.log(`check-urls: timeout checking ${url}`);
      return "timeout";
    }
    // DNS failure / connection refused / TLS failure all land here as
    // TypeError in Deno's fetch — no HTTP response was ever received.
    const message = err instanceof Error ? err.message : String(err);
    console.log(`check-urls: unreachable ${url}: ${message}`);
    return "unreachable";
  }
}

// ---------------------------------------------------------------------------
// Queue query
// ---------------------------------------------------------------------------

async function fetchEventsNeedingCheck(
  supabase: SupabaseClient,
  recheckIntervalDays: number
): Promise<EventRow[]> {
  const cutoff = new Date(
    Date.now() - recheckIntervalDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from("events")
    .select("id, event_url, rsvp_url, event_url_checked_at, rsvp_url_checked_at")
    .eq("is_active", true)
    .or(`event_url.not.is.null,rsvp_url.not.is.null`)
    .or(
      `event_url_checked_at.is.null,event_url_checked_at.lt.${cutoff},` +
        `rsvp_url_checked_at.is.null,rsvp_url_checked_at.lt.${cutoff}`
    )
    .order("event_url_checked_at", { ascending: true, nullsFirst: true })
    .limit(MAX_EVENTS_PER_RUN);

  if (error) throw error;
  return data ?? [];
}

async function getRecheckIntervalDays(supabase: SupabaseClient): Promise<number> {
  const { data } = await supabase
    .from("config")
    .select("value")
    .eq("key", "url_recheck_interval_days")
    .maybeSingle();
  const parsed = data ? parseInt(data.value, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : 14;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const recheckIntervalDays = await getRecheckIntervalDays(supabase);

  let events: EventRow[];
  try {
    events = await fetchEventsNeedingCheck(supabase, recheckIntervalDays);
  } catch (err) {
    console.error("check-urls: failed to fetch events:", err);
    return new Response(JSON.stringify({ error: "DB query failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const counts: Record<string, number> = { checked: 0, skipped: 0 };
  const bump = (status: string) => {
    counts[status] = (counts[status] ?? 0) + 1;
  };
  const now = new Date().toISOString();

  for (const event of events) {
    const update: Record<string, unknown> = {};

    // event_url: always stamp checked_at once we've decided what to do
    // with it, whether or not it turned out to be checkable — otherwise
    // a value that never resolves to a checkable target (an @handle,
    // garbage OCR output) gets silently re-selected by the queue query
    // on every single run, forever.
    if (event.event_url) {
      const checkTarget = normalizeForCheck(event.event_url);
      update.event_url_checked_at = now;
      if (checkTarget) {
        const status = await checkUrl(checkTarget);
        update.event_url_status = status;
        counts.checked++;
        bump(status);
      } else {
        // Doesn't parse as a URL and doesn't look like a bare host either
        // (e.g. "@thebrotherhood") — not applicable, not unchecked.
        counts.skipped++;
      }
    }

    if (event.rsvp_url) {
      const checkTarget = normalizeForCheck(event.rsvp_url);
      update.rsvp_url_checked_at = now;
      if (checkTarget) {
        const status = await checkUrl(checkTarget);
        update.rsvp_url_status = status;
        counts.checked++;
        bump(status);
      } else {
        // Non-URL rsvp_url (an email address) — stamp checked so it
        // doesn't get re-selected by the queue query every run, but
        // leave rsvp_url_status null: "not applicable", not "unchecked".
        counts.skipped++;
      }
    }

    if (Object.keys(update).length > 0) {
      const { error } = await supabase.from("events").update(update).eq("id", event.id);
      if (error) console.error(`check-urls: update failed for ${event.id}:`, error);
    }
  }

  console.log(`check-urls: ${JSON.stringify(counts)}`);

  return new Response(JSON.stringify(counts), {
    headers: { "Content-Type": "application/json" },
  });
});