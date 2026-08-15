// Model IDs for every Anthropic call in the edge functions.
//
// Centralized so "what is each pipeline stage running?" is answerable by
// reading one file. The *reasoning* for a given choice stays at its call
// site, where the surrounding code gives it context — see the comment above
// the extract call for why extraction moved off Sonnet 4.6, and the comment
// above the enrich model selection for the Sonnet/Haiku first-pass split.
//
// The web app's chat route has one Anthropic call and already keeps its model
// in a local `MODEL` constant (web/app/api/chat-v2/route.ts). Next.js can't
// import across the supabase/ tree, so that stays where it is — one constant
// for one call site doesn't earn its own module.
//
// PINNING IS CURRENTLY INCONSISTENT and this file makes that visible rather
// than fixing it, because the fix is a judgment call:
//   - These edge-function IDs are floating aliases. They track the latest
//     snapshot of a model, so behavior can change under a tuned prompt with
//     no deploy on our side.
//   - The web chat route pins a dated snapshot (claude-haiku-4-5-20251001),
//     which is reproducible but needs a manual bump to pick up improvements.
// For an extraction pipeline with prompts tuned against specific model
// behavior, dated pins are the safer default. Switching means looking up the
// current snapshot ID for each model — don't guess at the date suffixes.

/** Vision extraction from bulletin board photos. */
export const EXTRACT_MODEL = "claude-sonnet-5";

/** Enrichment, first pass — writes narrative prose and talent bios. */
export const ENRICH_FIRST_PASS_MODEL = "claude-sonnet-5";

/** Enrichment, re-enrichment passes — cheaper; checks whether new signal changes results. */
export const ENRICH_REPEAT_MODEL = "claude-haiku-4-5";

/** Board submission review — short structured verdict on a description. */
export const BOARD_REVIEW_MODEL = "claude-sonnet-4-6";

/** Talent name review — one web search, one structured verdict. */
export const TALENT_REVIEW_MODEL = "claude-haiku-4-5";