# enrich

Web search enrichment for extracted events. Runs as a cron job (every minute),
processing one event per invocation.

## Design principle

`events` holds what the flyer says. Web search results are never written to `events`
field columns. This distinction matters: the flyer is the ground truth; a web result
might be for a different show by the same artist in a different city.

Web-found data has two destinations:
- **`event_sightings.enrichment_data`** — structured JSON of what the web found,
  stored as a separate data layer. The presentation layer reads from here to display
  a distinct "found online" section with source attribution.
- **`event_verifications`** — one row per web source; feeds the confidence trigger.
  This is the only path by which enrichment affects the `events` table — indirectly,
  via the computed confidence score.

## How it works

After extraction, events sit in a queue defined by `enrichment_attempted_at IS NULL`.
The cron job calls this function every minute; it picks the oldest unenriched event,
searches the web for supporting information, writes results to `enrichment_data` and
`event_verifications`, and stamps `enrichment_attempted_at` to remove the event from
the queue.

If a new sighting arrives for an already-enriched event, `extract` resets
`enrichment_attempted_at = NULL`, re-queuing it with fresh data.

Events with `flyer_style = 'minimal'` are never enriched — their sparse fields
are intentional.

## Contact display policy

The pipeline stores whatever the web search found in `enrichment_data` without
filtering. `enrichment_data` is on `event_sightings`, which is not a public field.
The presentation layer is responsible for what to surface — only public-facing URLs
(venue websites, booking pages, org sites), never personal phone numbers or personal
email addresses.

## Geo validation

The enrichment prompt includes the board's city as a hard constraint. The web search
tool also receives `user_location` for result biasing. `user_location` is a soft hint
and does not guarantee results are local — the city constraint in the prompt is the
stronger control. If the web returns a result for a different city, it lands in
`enrichment_data` with whatever the model found; it does not update `events` fields
regardless.

## Setup (per environment)

**1. Enable web search in Claude Console**
Settings → Privacy → Web Search → Enable
Required before any API calls will work.

**2. Deploy the function**
```bash
supabase functions deploy enrich
```
No new secrets needed — uses the existing `ANTHROPIC_API_KEY`.

**3. Create the cron job**
Dashboard → Integrations → Cron → Create job:
- Name: `enrich-queue`
- Schedule: `* * * * *`
- Type: Edge Function → `enrich`
- Method: POST, Body: `{}`

Supabase injects auth automatically for Edge Function cron jobs.

## Queue depth

```sql
SELECT
  COUNT(*) FILTER (WHERE enrichment_attempted_at IS NULL)     AS pending,
  COUNT(*) FILTER (WHERE enrichment_attempted_at IS NOT NULL) AS attempted
FROM events
WHERE is_active = true AND flyer_style != 'minimal';
```

## Monitoring

Check recent cron runs:
```sql
SELECT status, start_time, end_time, return_message
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'enrich-queue')
ORDER BY start_time DESC
LIMIT 10;
```

Check enrichment results:
```sql
SELECT e.name, e.enrichment_attempted_at, e.confidence_score,
       es.enrichment_data,
       COUNT(ev.id) AS sources_found
FROM events e
LEFT JOIN event_sightings es ON es.event_id = e.id
LEFT JOIN event_verifications ev ON ev.event_id = e.id
WHERE e.enrichment_attempted_at IS NOT NULL
GROUP BY e.id, es.enrichment_data
ORDER BY e.enrichment_attempted_at DESC
LIMIT 20;
```

## Pricing

Web search costs $10 per 1,000 searches. Each event uses at most 3 searches
(`max_uses: 3`), so worst case $0.03/event. Monitor usage in Claude Console.
