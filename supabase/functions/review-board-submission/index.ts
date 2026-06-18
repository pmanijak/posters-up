import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY        = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL             = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ============================================================
// TYPES
// ============================================================

interface Submission {
  id:          string;
  board_id:    string;
  description: string | null;
  is_indoor:   boolean | null;
}

interface ReviewResult {
  status:                "auto_approved" | "rejected";
  corrected_description: string | null;
  note:                  string;
}

// ============================================================
// REVIEW WITHOUT API
// Used when the submission has no description — only is_indoor.
// The DB CHECK constraint guarantees at least one field is set,
// so if we're here, is_indoor is non-null. Nothing to correct;
// approve immediately without an API call.
// ============================================================

function reviewWithoutDescription(): ReviewResult {
  return {
    status: "auto_approved",
    corrected_description: null,
    note: "Approved: no description to review",
  };
}

// ============================================================
// REVIEW WITH API
// Called when the submission includes a description.
// Claude checks whether it reads as a real navigation hint
// and corrects mechanical errors (typos, capitalization).
// Returns structured JSON — no prose, no explanation.
// ============================================================

async function reviewWithAPI(submission: Submission): Promise<ReviewResult> {
  const isIndoorNote = submission.is_indoor !== null
    ? `\nContributor reported indoor: ${submission.is_indoor}`
    : "";

  const prompt = `You are reviewing a contributor submission for a community bulletin board app called Posters Up. The contributor was standing at a physical bulletin board and submitted what they observed.

Contributor's description: "${submission.description}"${isIndoorNote}

Your job:

1. APPROVE or REJECT the description.
   Approve if it would help someone navigate to the board — even vaguely.
   A street name, intersection, or named place is enough.
   Reject only if it is clearly not a navigation hint: spam, a URL, a business name with no location context, random characters.
   Be generous — contributors are locals writing casually. "by the door at oly food coop" is approvable.

2. If approved: correct mechanical errors only.
   Fix: misspelled words, wrong capitalization of proper nouns and street names.
   Preserve: the contributor's phrasing, word choice, local shorthand ("Oly", "the Crypt", "4th Ave"), abbreviations, and punctuation style.
   If no corrections are needed, return null for corrected_description.
   Do not rephrase. Do not improve. Only fix clear errors.

Return ONLY valid JSON. No markdown, no explanation, no code fences.

{
  "status": "auto_approved" | "rejected",
  "corrected_description": "corrected text here" | null,
  "note": "brief explanation — what you corrected, or why you rejected"
}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-6",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const raw = data.content
    ?.filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("")
    .trim();

  if (!raw) throw new Error("Empty response from API");

  // Strip accidental markdown fences before parsing
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const result = JSON.parse(clean) as ReviewResult;

  // Validate the status field — don't trust the model blindly
  if (result.status !== "auto_approved" && result.status !== "rejected") {
    throw new Error(`Unexpected status value: ${result.status}`);
  }

  return result;
}

// ============================================================
// HANDLER
// ============================================================

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Pick the oldest pending submission
  const { data: submission, error: fetchError } = await supabase
    .from("board_submissions")
    .select("id, board_id, description, is_indoor")
    .eq("review_status", "pending")
    .order("submitted_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (fetchError) {
    console.error("Failed to fetch submission:", fetchError);
    return new Response(
      JSON.stringify({ error: fetchError.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!submission) {
    return new Response(
      JSON.stringify({ message: "No pending submissions" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  console.log(`Reviewing submission ${submission.id} for board ${submission.board_id}`);

  let result: ReviewResult;

  try {
    result = submission.description
      ? await reviewWithAPI(submission as Submission)
      : reviewWithoutDescription();
  } catch (err) {
    // On API or parse failure, leave the submission pending so it retries
    // next invocation. A transient failure shouldn't permanently reject
    // a valid submission.
    console.error(`Review failed for submission ${submission.id}:`, err);
    return new Response(
      JSON.stringify({ error: String(err), submission_id: submission.id }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Write the review result back to the submission.
  // The trg_board_submission_approved trigger fires automatically
  // when status transitions to auto_approved, calling
  // apply_board_submission() to write consensus values to boards.
  const { error: updateError } = await supabase
    .from("board_submissions")
    .update({
      review_status:         result.status,
      corrected_description: result.corrected_description,
      ai_review_note:        result.note,
      reviewed_at:           new Date().toISOString(),
    })
    .eq("id", submission.id);

  if (updateError) {
    console.error("Failed to write review result:", updateError);
    return new Response(
      JSON.stringify({ error: updateError.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  console.log(`Submission ${submission.id} → ${result.status}. Note: ${result.note}`);

  return new Response(
    JSON.stringify({
      submission_id:         submission.id,
      board_id:              submission.board_id,
      status:                result.status,
      corrected_description: result.corrected_description,
      note:                  result.note,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});