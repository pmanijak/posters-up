-- ============================================================
-- Lock down internal pipeline functions -- corrected version.
--
-- Superseded an earlier draft that (a) missed ~13 functions the
-- original code-grep didn't cover, and (b) misjudged the actual risk:
-- table grants on events/event_sightings/talent/boards/photos already
-- restrict anon/authenticated to SELECT, so most of these functions
-- fail on their own write statement even when directly callable.
-- Confirmed live via pg_proc (prosecdef, identity args) and by reading
-- apply_board_submission's body before including it.
--
-- Trigger functions (trg_apply_on_approval, trg_recompute_on_sighting,
-- trg_recompute_on_verification) are deliberately EXCLUDED: Postgres
-- refuses to invoke a RETURNS trigger function outside trigger context
-- regardless of EXECUTE grants, so revoking them fixes nothing.
--
-- Two groups below:
--  - inert-but-hygiene: table grants already stop the write; revoking
--    EXECUTE here is defense-in-depth against future grant drift, not
--    a live fix.
--  - dry-run cost risk: run_dedup_pass / run_talent_dedup_pass /
--    run_field_reconciliation_pass / reconstruct_talent_from_sightings /
--    split_event can likely run their full (expensive -- handoff.md
--    flags run_dedup_pass's own N^2 risk) computation in dry-run mode
--    without touching a write-restricted table -- this is the live,
--    exploitable-today piece (free repeated compute via public RPC).
--
-- Confirmed safe against the pipeline: every Edge Function
-- (extract, enrich, extract-drain, check-urls, review-board-submission,
-- resolve-talent-name, delete-account, embed) uses
-- SUPABASE_SERVICE_ROLE_KEY exclusively, which bypasses grants entirely.
-- ============================================================

-- inert-but-hygiene
REVOKE EXECUTE ON FUNCTION apply_board_submission(uuid)                              FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION claim_pending_photos()                                     FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION compute_event_confidence(uuid)                             FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION confirm_talent_from_sighting(uuid, text[])                 FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION mark_embedding_attempted(uuid)                             FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION mark_enrichment_attempted(uuid)                            FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION maybe_reenqueue_enrichment(uuid, text, text, date, text)    FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION merge_events(uuid, uuid)                                   FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION merge_events(uuid, uuid, text)                             FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION merge_talent(uuid, uuid, text)                             FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION reap_stale_processing_photos()                             FROM anon, authenticated;

-- dry-run cost risk -- the actual priority
REVOKE EXECUTE ON FUNCTION run_dedup_pass(boolean)                                    FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION run_talent_dedup_pass(boolean, boolean)                    FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION run_field_reconciliation_pass(boolean)                     FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION reconstruct_talent_from_sightings(boolean)                 FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION split_event(uuid, uuid[], boolean)                         FROM anon, authenticated;

-- NOTE: deliberately NOT including normalize_event_name,
-- generate_search_text, event_name_similarity, board_lat_lng,
-- find_nearby_board, cluster_event_name_buckets, or
-- event_components_share_date/location/talent in this pass --
-- their signatures above were inferred from grep, not confirmed via
-- pg_get_function_identity_arguments the way the list above was.
-- Run the same signature-lookup query against these names before
-- adding them, rather than guess and risk a mid-migration error.