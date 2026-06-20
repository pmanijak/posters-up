CREATE OR REPLACE FUNCTION apply_board_submission(p_board_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_description                  TEXT;
  v_requires_entry_to_photograph BOOLEAN;
  v_requires_entry_to_post       BOOLEAN;
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

  -- entry flags: majority vote across approved submissions.
  SELECT mode() WITHIN GROUP (ORDER BY requires_entry_to_photograph)
  INTO v_requires_entry_to_photograph
  FROM board_submissions
  WHERE board_id      = p_board_id
    AND review_status = 'auto_approved'
    AND requires_entry_to_photograph IS NOT NULL;

  SELECT mode() WITHIN GROUP (ORDER BY requires_entry_to_post)
  INTO v_requires_entry_to_post
  FROM board_submissions
  WHERE board_id      = p_board_id
    AND review_status = 'auto_approved'
    AND requires_entry_to_post IS NOT NULL;

  -- Write back only fields that have at least one approved value.
  -- COALESCE preserves the existing boards value when no submissions
  -- have data for that field yet.
  UPDATE boards
  SET
    description                  = COALESCE(v_description,                  description),
    requires_entry_to_photograph = COALESCE(v_requires_entry_to_photograph, requires_entry_to_photograph),
    requires_entry_to_post       = COALESCE(v_requires_entry_to_post,       requires_entry_to_post),
    updated_at                   = now()
  WHERE id = p_board_id;
END;
$$;