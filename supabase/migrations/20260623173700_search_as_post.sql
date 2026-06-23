CREATE OR REPLACE FUNCTION events_for_boards(board_ids UUID[])
RETURNS SETOF events_public
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ep.*
  FROM events_public ep
  WHERE ep.id IN (
    SELECT event_id
    FROM board_flyers
    WHERE board_id = ANY(board_ids)
      AND is_active = true
  );
$$;

GRANT EXECUTE ON FUNCTION events_for_boards(UUID[]) TO anon, authenticated;