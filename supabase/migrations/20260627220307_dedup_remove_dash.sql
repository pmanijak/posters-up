CREATE OR REPLACE FUNCTION normalize_event_name(p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT
AS $$
DECLARE
  result TEXT;
BEGIN
  result := lower(p_name);

  -- Strip trailing "at Venue" / "@ Venue" suffix.
  result := regexp_replace(result, '\s+at\s+\S.*$', '', 'g');
  result := regexp_replace(result, '\s+@\s+\S.*$',  '', 'g');

  -- Strip inline date fragments: "June 18", "Jun 18", "July 4th".
  result := regexp_replace(result,
    '\m(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{1,2}(st|nd|rd|th)?\M',
    '', 'gi');

  -- Strip bare 4-digit years.
  result := regexp_replace(result, '\m20\d{2}\M', '', 'g');

  -- Strip remaining punctuation.
  result := regexp_replace(result, '[^a-z0-9 ]', '', 'g');

  -- Strip filler words.
  result := regexp_replace(result,
    '\y(the|a|an|and|presents|feat|featuring|with|at|in|on)\y', '', 'g');

  result := regexp_replace(result, '\s+', ' ', 'g');
  RETURN trim(result);
END;
$$;