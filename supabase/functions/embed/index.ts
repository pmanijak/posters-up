// supabase/functions/embed/index.ts
//
// Embedding generation for events.
// Runs on a cron schedule (every minute), processing one event per invocation.
//
// Queue state tracked via events.embedding_attempted_at:
//   null     = not yet attempted, eligible
//   non-null = already attempted; not reset automatically (unlike enrichment,
//              there's no re-queue trigger — search_text changes are rare and
//              small enough that stale embeddings are acceptable)
//
// Queue condition:
//   is_active = true
//   AND search_text IS NOT NULL
//   AND embedding IS NULL
//   AND embedding_attempted_at IS NULL
//
// Falls through gracefully if OPENAI_EMBEDDING_API_KEY is not set — safe to deploy
// before the key is available.
//
// Setup:
//   1. Add OPENAI_EMBEDDING_API_KEY to Supabase secrets
//   2. supabase functions deploy embed
//   3. Dashboard → Integrations → Cron → Create job:
//        Name: embed-queue
//        Schedule: * * * * *
//        Type: Edge Function → embed
//        Method: POST, Body: {}

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const OPENAI_EMBEDDING_API_KEY  = Deno.env.get("OPENAI_EMBEDDING_API_KEY");
const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const EMBEDDING_MODEL    = "text-embedding-3-small";
const EMBEDDING_DIMS     = 1536;
const MAX_EVENTS_PER_RUN = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EventRow {
  id: string;
  name: string;
  search_text: string;
  embedding_attempt_count: number;
}

// ---------------------------------------------------------------------------
// Queue query
// ---------------------------------------------------------------------------

async function fetchEventsNeedingEmbedding(supabase: SupabaseClient): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from("events")
    .select("id, name, search_text, embedding_attempt_count")
    .eq("is_active", true)
    .not("search_text", "is", null)
    .is("embedding", null)
    .is("embedding_attempted_at", null)
    .order("created_at", { ascending: true })
    .limit(MAX_EVENTS_PER_RUN);

  if (error) throw error;
  return (data ?? []).filter(r => r.search_text);
}

// ---------------------------------------------------------------------------
// OpenAI embeddings call
// ---------------------------------------------------------------------------

async function generateEmbedding(text: string): Promise<number[] | null> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${OPENAI_EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({
      model:      EMBEDDING_MODEL,
      input:      text,
      dimensions: EMBEDDING_DIMS,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("OpenAI API error:", res.status, body);
    return null;
  }

  const data = await res.json();
  return data?.data?.[0]?.embedding ?? null;
}

// ---------------------------------------------------------------------------
// Mark attempted
//
// Calls mark_embedding_attempted() which stamps embedding_attempted_at and
// increments embedding_attempt_count atomically.
// Called after every attempt, successful or not.
// ---------------------------------------------------------------------------

async function markAttempted(supabase: SupabaseClient, eventId: string): Promise<void> {
  const { error } = await supabase.rpc("mark_embedding_attempted", {
    p_event_id: eventId,
  });
  if (error) console.error(`mark_embedding_attempted failed for event ${eventId}:`, error);
}

// ---------------------------------------------------------------------------
// Process a single event
// ---------------------------------------------------------------------------

async function processEvent(
  supabase: SupabaseClient,
  event: EventRow
): Promise<"embedded" | "failed"> {
  const embedding = await generateEmbedding(event.search_text);

  // Mark attempted regardless of outcome — prevents retry storms on transient
  // API failures. Manually clear embedding_attempted_at to re-queue if needed.
  await markAttempted(supabase, event.id);

  if (!embedding) {
    await supabase
      .from("events")
      .update({ embedding_status: "failed" })
      .eq("id", event.id);
    return "failed";
  }

  // pgvector expects the embedding as a JSON array string.
  const { error } = await supabase
    .from("events")
    .update({
      embedding:        JSON.stringify(embedding),
      embedding_status: "complete",
    })
    .eq("id", event.id);

  if (error) {
    console.error(`embedding write failed for event ${event.id}:`, error);
    await supabase
      .from("events")
      .update({ embedding_status: "failed" })
      .eq("id", event.id);
    return "failed";
  }

  return "embedded";
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // No-op gracefully until the key is available — safe to deploy and schedule
  // before the OpenAI account is set up.
  if (!OPENAI_EMBEDDING_API_KEY) {
    return new Response(
      JSON.stringify({ embedded: 0, failed: 0, message: "OPENAI_EMBEDDING_API_KEY not set — skipping" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let events: EventRow[];
  try {
    events = await fetchEventsNeedingEmbedding(supabase);
  } catch (err) {
    console.error("Failed to fetch events:", err);
    return new Response(JSON.stringify({ error: "DB query failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (events.length === 0) {
    return new Response(
      JSON.stringify({ embedded: 0, failed: 0, message: "Queue empty" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  const counts = { embedded: 0, failed: 0 };

  for (const event of events) {
    const outcome = await processEvent(supabase, event);
    counts[outcome]++;
    console.log(`embed: ${event.name} (attempt #${event.embedding_attempt_count + 1}) → ${outcome}`);
  }

  return new Response(JSON.stringify(counts), {
    headers: { "Content-Type": "application/json" },
  });
});