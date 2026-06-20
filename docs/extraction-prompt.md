# Bulletin Board Extraction Prompt — Developer Notes

The system prompt text lives at `supabase/functions/extract/system-prompt.txt`
and is read by the Edge Function at deploy time. Add `system-prompt.txt` as a
Claude project file so it's in context every session.

To update the prompt: edit `system-prompt.txt`, then `supabase functions deploy extract`.
No code change needed.

---

## User Message Template

```
Photo taken: {{capture_date}}
Board location: {{board_description_or_null}}
Known events on this board as of last photo: {{known_events_json_or_null}}

Extract all items from this bulletin board photo.
```

---

## Developer Notes

**capture_date** — ISO date from EXIF (not upload time). Already reading
EXIF for GPS; pull the timestamp at the same time.

**known_events_json** — compact JSON array of {name, date_start} from the
previous extraction for this board. Pass null for first-time boards.
Limit to the 10 most recent by last_seen_at to avoid the prompt
ballooning on heavily-trafficked boards. Helps the model focus on what
is new rather than re-extracting everything.

**Schema mapping**
- Each object → `event_sightings.raw_extraction`
- `confidence` → `event_sightings.extraction_confidence`
- `flyer_style` → `event_sightings.flyer_style`
- `organization` → seeds or matches `organizations`
- `talent[]` → seeds `talent` records + `event_talent` rows
- `event_category`, `tags`, `age_restriction`, `is_outdoor`,
  `accessibility`, `masks_required`, `language`, `is_public` →
  promoted to `events` during deduplication/merge
- `price_raw`, `is_free` → `events`
- `event_url` → `events.event_url`; also fed to verification pipeline
  as first URL candidate for dedup (URL match = hard dedup key)
- `rsvp_required`, `rsvp_url` → `events`

**Not handled here**
- Deduplication — pipeline concern
- Web search enrichment — second pipeline stage
- `search_text` + `embedding` generation — post-approval pipeline step
- Venue-level accessibility — comes from web enrichment, not flyers

**Field resolution during dedup/merge**
When a new sighting merges with an existing event, scalar fields
(event_category, age_restriction, language, is_outdoor, is_public,
masks_required) follow a last-write-wins rule only if the incoming
value is non-null. Arrays (tags, accessibility) are union-merged and
deduplicated. price_raw and event_url use the most recent non-null
value. This means a second sighting can fill in fields a first sighting
missed — the schema is additive by design.

**Watch for**
- Dark-background gig posters: model may truncate text without flagging
  it. Watch for partially-filled fields missing a confidence_note.
- Minimal flyers: model may over-flag null fields as low confidence
  rather than recognizing them as intentional. Check that flyer_style
  is "minimal" and confidence_note says "withheld by design" rather
  than describing a reading failure.
- QR codes: visible in many modern flyers but not machine-readable by
  vision models. Note presence in confidence_note; set event_url null.
- Wheelchair symbol: the ♿ pictogram should reliably trigger
  "wheelchair" in the accessibility array even without text.
- Age restriction inference: a flyer for a show at a bar with no age
  statement can reasonably default to "21+" — note the inference in
  confidence_note. Don't infer "all_ages" without a signal.
- Crossed-out or struck-through text: a struck price, date, or venue is
  being retracted, not reported. Use the "[crossed out: X] Y" convention
  in the field — never populate a field with the struck value alone.
  Handwritten replacements next to struck text combine two uncertainties
  (retraction intent + legibility); note both in confidence_note and
  reduce confidence accordingly.
- Tags on minimal flyers: genre tags (punk, DIY) are often inferable
  from visual style alone — rough xerox aesthetic strongly implies
  punk/DIY even with no text confirming it.
- Multi-performance runs: a show running several days with varying
  showtimes should still be date_type "specific" with date_start/
  date_end covering the full span. Don't let variable showtimes push
  it into "approximate". Put the full schedule in description verbatim.
- Hours of operation: "Open daily 9am–9pm" will pattern-match to a
  recurring event. Signal to distinguish: no event name, no admission
  info, no talent or organizer — just a time range tied to the location.
  These should be skipped entirely at extraction time.
