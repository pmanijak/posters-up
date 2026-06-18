-- ============================================================
-- Migration: board_submissions
-- Adds contributor-submitted board details and AI review pipeline.
--
-- Design:
--   - Contributors submit what they can observe standing at the board:
--     description (navigation hint) and is_indoor.
--   - AI review corrects mechanical typos, preserves contributor voice,
--     and gates obvious spam/nonsense. Not a confidence score — just a
--     quality and sanity check.
--   - Approved submissions feed apply_board_submission(), which writes
--     consensus values back to boards. Triggered automatically.
--   - description: last-write-wins on approved submissions. Most recent
--     approved contributor description is the canonical one.
--   - is_indoor: mode across all approved submissions.
--     Multiple contributors agreeing is the trust signal.
--   - board_type is intentionally omitted. The description captures
--     venue character better than an enum, doesn't go stale when
--     businesses change, and avoids a vocabulary that would need
--     revisiting as the app expands to new cities.
--   - Posting requirements (managed_by, posting_policy,
--     allowed_content_types) are intentionally deferred. They require
--     information contributors can't reliably observe at submission time.
-- ============================================================


-- ============================================================
-- TABLE
-- ============================================================

CREATE TABLE board_submissions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id      UUID        NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  submitted_by  UUID        REFERENCES users(id)   ON DELETE SET NULL,
  photo_id      UUID        REFERENCES photos(id)  ON DELETE SET NULL,

  -- What the contributor observed standing at the board.
  -- At least one field must be non-null (see constraint below).
  description   TEXT,
                -- Navigation-quality hint: specific enough to find
                -- the board without GPS. Contributor's own words.
                -- "Inside Rainy Day Records, on the wall left of
                -- the front door" — not just "Rainy Day Records".
  is_indoor     BOOLEAN,
                -- Observable on the spot. True = inside a building.

  -- Require at least one field — a completely empty submission
  -- is useless and shouldn't reach the review queue.
  CONSTRAINT board_submissions_has_content CHECK (
    description IS NOT NULL OR
    is_indoor   IS NOT NULL
  ),

  -- AI review.
  -- The AI corrects mechanical errors in the description before
  -- writing corrected_description. If no corrections are needed,
  -- corrected_description is null and description is used as-is.
  -- Voice, phrasing, and local shorthand are always preserved.
  review_status         TEXT        NOT NULL DEFAULT 'pending',
                        -- 'pending'       — awaiting AI review
                        -- 'auto_approved' — passed AI review
                        -- 'rejected'      — spam, nonsense, or not
                        --                   a navigation description
  corrected_description TEXT,
                        -- AI-corrected version of description.
                        -- Null if no corrections were made.
                        -- Never changes the meaning — typos and
                        -- capitalization only.
  ai_review_note        TEXT,
                        -- What the AI did. Examples:
                        --   "Corrected typo: 'Recrods' → 'Records'"
                        --   "No corrections needed"
                        --   "Rejected: not a navigation description"
  reviewed_at           TIMESTAMPTZ,

  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_board_submissions_board   ON board_submissions(board_id);
CREATE INDEX idx_board_submissions_user    ON board_submissions(submitted_by);
CREATE INDEX idx_board_submissions_photo   ON board_submissions(photo_id);
CREATE INDEX idx_board_submissions_status  ON board_submissions(review_status);
CREATE INDEX idx_board_submissions_recent  ON board_submissions(board_id, submitted_at DESC);


-- ============================================================
-- CONSENSUS FUNCTION
-- Called after any board_submission is approved.
-- Writes agreed values back to boards.
--
-- description — the effective description from the most recently
--               approved submission (corrected if the AI made
--               corrections, original otherwise).
-- is_indoor   — mode across all approved submissions that set it.
--
-- Only fields with at least one approved submission are updated.
-- A field with no approved data is left at its current boards value.
-- ============================================================

CREATE OR REPLACE FUNCTION apply_board_submission(p_board_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_description TEXT;
  v_is_indoor   BOOLEAN;
BEGIN
  -- description: most recent approved submission.
  -- Use corrected_description when the AI made corrections;
  -- fall back to the contributor's original otherwise.
  SELECT COALESCE(corrected_description, description)
  INTO v_description
  FROM board_submissions
  WHERE board_id      = p_board_id
    AND review_status = 'auto_approved'
    AND (description IS NOT NULL OR corrected_description IS NOT NULL)
  ORDER BY submitted_at DESC
  LIMIT 1;

  -- is_indoor: majority vote across approved submissions.
  SELECT mode() WITHIN GROUP (ORDER BY is_indoor)
  INTO v_is_indoor
  FROM board_submissions
  WHERE board_id      = p_board_id
    AND review_status = 'auto_approved'
    AND is_indoor IS NOT NULL;

  -- Write back only fields that have at least one approved value.
  -- COALESCE preserves the existing boards value when no submissions
  -- have data for that field yet.
  UPDATE boards
  SET
    description = COALESCE(v_description, description),
    is_indoor   = COALESCE(v_is_indoor,   is_indoor),
    updated_at  = now()
  WHERE id = p_board_id;
END;
$$;


-- ============================================================
-- TRIGGER
-- Runs apply_board_submission() whenever a submission transitions
-- to auto_approved. Fires on UPDATE only — INSERT starts as
-- 'pending' and is handled by the AI review pipeline separately.
-- ============================================================

CREATE OR REPLACE FUNCTION trg_apply_on_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.review_status = 'auto_approved'
     AND OLD.review_status != 'auto_approved' THEN
    PERFORM apply_board_submission(NEW.board_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_board_submission_approved
AFTER UPDATE ON board_submissions
FOR EACH ROW EXECUTE FUNCTION trg_apply_on_approval();


-- ============================================================
-- BOARDS TABLE: add is_indoor and updated_at
-- Neither was in v7.
-- is_indoor: set by consensus across board_submissions.
-- updated_at: tracks when the consensus function last wrote back.
-- Also drop board_type from boards — the description covers it.
-- ============================================================

ALTER TABLE boards ADD COLUMN IF NOT EXISTS is_indoor   BOOLEAN;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE boards DROP COLUMN IF EXISTS board_type;

CREATE INDEX IF NOT EXISTS idx_boards_indoor ON boards(is_indoor)
  WHERE is_indoor IS NOT NULL;


-- ============================================================
-- boards_public VIEW: reflect schema changes
-- Drop and recreate — Postgres doesn't support ALTER COLUMN on views.
-- board_type removed; is_indoor added.
-- ============================================================

DROP VIEW IF EXISTS boards_public;

CREATE VIEW boards_public AS
SELECT
  b.id,
  b.geolocation,
  b.description,
  b.is_indoor,
  b.posting_policy,
  b.allowed_content_types,
  b.first_sighted_at,
  b.last_sighted_at,
  COUNT(bf.id) FILTER (WHERE bf.is_active = true)  AS active_flyer_count,
  COUNT(bf.id)                                      AS total_flyer_count,
  ARRAY_AGG(DISTINCT e.content_type)
    FILTER (WHERE bf.is_active = true)              AS content_mix
FROM boards b
LEFT JOIN board_flyers bf ON bf.board_id = b.id
LEFT JOIN events e        ON e.id = bf.event_id
WHERE b.is_active = true
GROUP BY b.id;


-- ============================================================
-- AI REVIEW PIPELINE (Edge Function reference)
--
-- The review step runs as a Supabase Edge Function
-- (review-board-submission) on a cron schedule (every minute).
-- It is not implemented in SQL — this comment documents the
-- contract so the Edge Function stays in sync with the schema.
--
-- INPUT (read from board_submissions row):
--   id, board_id, description, is_indoor
--
-- WHAT THE AI CHECKS (description only; is_indoor needs no review):
--   1. Is description a real navigation hint?
--      Generous threshold — "by the door at oly food coop" passes.
--      Reject only: spam, URLs, a business name with no location
--      context, random characters.
--   2. Typo correction:
--      Fix: misspellings, wrong capitalization of proper nouns.
--      Preserve: phrasing, local shorthand, abbreviations.
--      Return null for corrected_description if unchanged.
--
-- OUTPUT (write back to board_submissions row):
--   review_status         = 'auto_approved' | 'rejected'
--   corrected_description = corrected text, or null if unchanged
--   ai_review_note        = brief explanation
--   reviewed_at           = now()
--
-- REJECTION EXAMPLES:
--   "asdfgh"             → rejected: not a description
--   "Rainy Day Records"  → rejected: name only, no location context
--   "http://spam.com"    → rejected: URL
--
-- APPROVAL EXAMPLES:
--   "inside Rainy Day Recrods on 5th Ave, left of the door"
--     → approved; corrected: "Recrods" → "Records"
--   "on the wall outside oly food coop on eastside"
--     → approved; no corrections (local shorthand preserved)
--   "Corner of 5th and Franklin, on the brick wall facing Franklin"
--     → approved; no corrections needed
-- ============================================================