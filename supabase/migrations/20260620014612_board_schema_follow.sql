ALTER TABLE board_submissions
  DROP COLUMN IF EXISTS is_indoor,
  ADD COLUMN IF NOT EXISTS requires_entry_to_photograph BOOLEAN,
  ADD COLUMN IF NOT EXISTS requires_entry_to_post       BOOLEAN;