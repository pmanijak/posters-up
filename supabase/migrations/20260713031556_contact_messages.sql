-- ============================================================
-- CONTACT MESSAGES
-- ============================================================
-- General "users want to reach us" inbox — takedown requests, feedback,
-- "my venue's info is wrong," bug reports. Distinct from event_reports,
-- which is a structured flag against one specific event with its own
-- moderation lifecycle. This is free-text correspondence with no reply
-- threading: a one-shot mailbox drop, not a support-ticket system.
--
-- Write-only from the outside. No admin app or notification pipeline
-- exists yet — the read side is Supabase Studio's Table Editor, same
-- posture as working the event_reports / possible_false_merge queue by
-- hand today. Revisit automated notification once real volume shows up.

CREATE TABLE contact_messages (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Optional. Null means no reply is possible/expected — an anonymous
  -- tip or a takedown request sent without wanting further contact.
  email        TEXT,

  category     TEXT        NOT NULL DEFAULT 'other'
               CHECK (category IN ('bug', 'wrong_info', 'takedown', 'feedback', 'other')),

  message      TEXT        NOT NULL CHECK (length(trim(message)) > 0),

  -- Page the sender was on, if submitted client-side. Mainly useful
  -- for 'wrong_info' and 'bug' categories to skip a round of back-and-forth.
  context_url  TEXT,

  -- Optional link to a specific event, if the contact form is ever reused
  -- as an entry point from an event page. Free text about the event, not
  -- a structured report — event_reports stays the tool for that.
  event_id     UUID        REFERENCES events(id) ON DELETE SET NULL,

  status       TEXT        NOT NULL DEFAULT 'new'
               CHECK (status IN ('new', 'read', 'resolved')),

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contact_messages_status  ON contact_messages(status);
CREATE INDEX idx_contact_messages_created ON contact_messages(created_at DESC);

-- No automated notification for now (email digest deferred until there's
-- real volume to justify it) — check via Studio's Table Editor, filtered
-- to status = 'new', same workflow as the possible_false_merge queue.

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE contact_messages ENABLE ROW LEVEL SECURITY;

-- No auth wall — someone reporting bad info or asking for a takedown
-- shouldn't need an account. Insert-only: no SELECT policy for anon or
-- authenticated, so a submitter can never read back other people's
-- messages (or their own) through the API, only through Studio as
-- service_role.
CREATE POLICY "anyone can submit a contact message" ON contact_messages
  FOR INSERT TO anon, authenticated WITH CHECK (true);

GRANT INSERT ON contact_messages TO anon, authenticated;
REVOKE TRUNCATE ON contact_messages FROM anon, authenticated;

-- service_role already has ALL via the blanket
-- "GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role" statement
-- in schema_current.sql — no additional grant needed here.