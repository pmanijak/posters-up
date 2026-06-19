GRANT SELECT ON events_public         TO anon, authenticated;
GRANT SELECT ON boards_public         TO anon, authenticated;
GRANT SELECT ON event_board_locations TO anon, authenticated;
GRANT SELECT ON venues_public         TO anon, authenticated;
GRANT SELECT ON talent_public         TO anon, authenticated;

GRANT SELECT ON events_public         TO service_role;
GRANT SELECT ON boards_public         TO service_role;
GRANT SELECT ON event_board_locations TO service_role;
GRANT SELECT ON venues_public         TO service_role;
GRANT SELECT ON talent_public         TO service_role;