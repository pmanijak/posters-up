import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Config ─────────────────────────────────────────────────────────────────

// Reuses the same key as the enrich function -- same kind of task
// (Claude + web search, structured verdict), no reason for a separate one.
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_ENRICH_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Prompt ─────────────────────────────────────────────────────────────────
//
// This is a much simpler task than event enrichment: one web search, one
// yes/no-ish structured verdict. Haiku, matching the "re-enrichment uses
// Haiku (cheaper)" convention already established for the lighter-weight
// passes in this pipeline.

const SYSTEM_PROMPT = `You are checking talent names extracted (via AI vision) from photos of physical bulletin board flyers for small local events -- concerts, art shows, community events. OCR/extraction sometimes glues two adjacent pieces of flyer text into one "name" -- e.g. an event-format prefix ("Trivia Night") stuck onto a real performer name ("Jamie Delgado"), or two different lineup entries run together with no separator ("Two Left Feet" + "The Loud Nopes").

You'll be given the candidate name and why it was flagged -- often including a raw word count, a word count with "&"/"and"/"the" excluded, and whether the name contains a dash. These were computed deterministically before you saw this, not guessed. Use them.

You do NOT need to search for every candidate. Reason it through directly and call resolve_talent_name without searching when the structure alone makes the answer clear -- a dash between an obvious event-format/genre term ("Trivia Night", "Open Mic", "Bingo") and what reads as a person's name is essentially always contamination; call likely_split immediately in that case, no search needed. A "likely_split" verdict from clear structural reasoning is safe without search -- worst case it routes to a human, nothing bad ships from being wrong in that direction.

Search the web when you're NOT confident from structure alone -- in particular, "this fits a common real-band pattern" (e.g. "X & the Y") is NOT the same as confirming the act exists. A "real_name" verdict should generally be backed by either search evidence or a case so structurally unambiguous (no dash, low word count once "&"/"and"/"the" are excluded, ordinary name shape) that searching wouldn't add anything. When in doubt about whether to search, search -- the cost of an unnecessary search is small; the cost of confidently clearing a name that's actually contamination is not.

Your evidence must confirm the SPECIFIC candidate name, not just "a real person/act with a similar or overlapping name exists." Sharing a first name, a genre, or a word is not confirmation -- finding a real musician named "Jordan Mitchell" does not confirm a candidate spelled "Jordan Tilford." If your search turns up a different real name that looks like what the candidate SHOULD say (a plausible OCR source for it), that's evidence for likely_split or for a corrected reading -- put the correct name in split_part_a and explain the relationship in reasoning -- not evidence for real_name on the candidate as literally written. When two spellings are being compared (you'll see this as "top candidate X vs runner-up Y" in what you're given), your evidence needs to say which SPECIFIC spelling is correct, not just that the general name is plausible.

Call resolve_talent_name exactly once with your findings.`;

const RESOLVE_TOOL = {
  name: "resolve_talent_name",
  description:
    "Report findings about whether a candidate talent name from a bulletin board flyer is one real performer/act, or contaminated text combining two adjacent flyer entries.",
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["real_name", "likely_split", "uncertain"],
        description:
          "real_name: confirmed (or reasonably believed) to be one real performer/band/artist. likely_split: evidence this combines two separate things. uncertain: no clear evidence either way.",
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      split_part_a: { type: "string", description: "If likely_split, the first suggested component" },
      split_part_b: { type: "string", description: "If likely_split, the second suggested component" },
      evidence_url: { type: "string", description: "Best supporting URL found, if any" },
      reasoning: { type: "string", description: "One or two sentences explaining the verdict" },
    },
    required: ["verdict", "confidence", "reasoning"],
  },
};

const STATUS_BY_VERDICT: Record<string, string> = {
  real_name: "resolved_real",
  likely_split: "resolved_split",
  uncertain: "resolved_uncertain",
};

// ── Request handler ────────────────────────────────────────────────────────
//
// Cron-triggered (mirror whatever schedule mechanism `enrich` already
// uses), one pending review per invocation -- same cost/rate-control
// pattern as enrich's "one event per invocation".

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: review, error: fetchError } = await supabase
    .from("talent_name_reviews")
    .select("id, candidate_name, name_key, flag_reason, flag_detail")
    .eq("status", "pending")
    .order("first_flagged_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (fetchError) {
    console.error("talent_name_reviews fetch error:", fetchError);
    return respond({ error: fetchError.message }, 500);
  }

  if (!review) {
    return respond({ message: "No pending talent name reviews" });
  }

  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 2048,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: `Candidate name: "${review.candidate_name}"\n\nFlagged because: ${review.flag_detail ?? review.flag_reason}`,
          },
        ],
        tools: [
          { type: "web_search_20250305", name: "web_search" },
          RESOLVE_TOOL,
        ],
        // Deliberately NOT forcing tool_choice to resolve_talent_name --
        // search is now optional (see SYSTEM_PROMPT), so forcing a
        // specific client tool up front would risk cutting off a search
        // Claude actually needs. Left as default (auto): Claude decides
        // per-candidate whether to search or reason directly from
        // flag_detail's already-computed signals. The toolUse-not-found
        // check below is the defensive fallback either way -- if Claude
        // doesn't call resolve_talent_name at all, the review stays
        // 'pending' and retries next invocation rather than being
        // marked resolved incorrectly.
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      throw new Error(`Claude API error ${claudeRes.status}: ${errText}`);
    }

    const claudeData = await claudeRes.json();
    const toolUse = claudeData.content?.find(
      (c: any) => c.type === "tool_use" && c.name === "resolve_talent_name"
    );

    if (!toolUse) {
      // Claude didn't call the tool -- leave status='pending' so this
      // retries next invocation instead of silently dropping the review.
      console.warn(`No resolve_talent_name call for "${review.candidate_name}" -- leaving pending`);
      return respond({ retried: true, candidate_name: review.candidate_name });
    }

    // Detected from the response shape, not self-reported by Claude --
    // more reliable for auditing whether search is actually being used
    // when it should be. NOTE: "server_tool_use" / "web_search_tool_result"
    // are the expected block type names for the hosted web_search tool
    // based on Anthropic's docs at time of writing; verify against an
    // actual response if this ever reads as false when you can see from
    // `reasoning` that Claude clearly did search.
    const usedWebSearch = claudeData.content?.some(
      (c: any) => c.type === "server_tool_use" || c.type === "web_search_tool_result"
    ) ?? false;

    const verdict = toolUse.input as {
      verdict: "real_name" | "likely_split" | "uncertain";
      confidence: "high" | "medium" | "low";
      split_part_a?: string;
      split_part_b?: string;
      evidence_url?: string;
      reasoning: string;
    };

    const { error: updateError } = await supabase
      .from("talent_name_reviews")
      .update({
        status: STATUS_BY_VERDICT[verdict.verdict] ?? "resolved_uncertain",
        verdict_confidence: verdict.confidence,
        split_suggestion_a: verdict.split_part_a ?? null,
        split_suggestion_b: verdict.split_part_b ?? null,
        evidence_url: verdict.evidence_url ?? null,
        reasoning: verdict.reasoning,
        used_web_search: usedWebSearch,
        resolved_by: usedWebSearch ? "claude_web_search" : "claude_reasoning",
        resolved_at: new Date().toISOString(),
      })
      .eq("id", review.id);

    if (updateError) throw updateError;

    return respond({ success: true, candidate_name: review.candidate_name, verdict });
  } catch (err: any) {
    // Leave status='pending' on failure -- retries next invocation
    // rather than being silently marked resolved.
    console.error(`resolve-talent-review failed for "${review.candidate_name}":`, err);
    return respond({ error: err.message, candidate_name: review.candidate_name }, 500);
  }
});