-- ============================================================
-- MIGRATION: talent_name_reviews queue
-- ============================================================
--
-- reconstruct_talent_from_sightings() flags suspicious_name and
-- ambiguous_name candidates but its output is transient -- a dry-run
-- result set, gone once the query returns. To let an AI (or a human)
-- work through the backlog asynchronously, flagged names need a
-- durable home.
--
-- Deliberately NOT wired back into reconstruct_talent_from_sightings()
-- yet -- that function has been through four real-bug-driven revisions
-- this session already. Shipping this as a separate, additive queue
-- lets the AI-resolution loop prove itself first; "skip the gate for
-- already-resolved names" is a clearly separate follow-up once verdict
-- quality is confirmed, not bundled into another revision of an
-- already-hardened function.
--
-- status lifecycle: pending -> resolved_real | resolved_split |
-- resolved_uncertain (via resolve-talent-review Edge Function) or
-- manually_resolved (human override, bypassing the AI entirely).
-- resolved_split doesn't auto-act -- there's no talent-name-splitting
-- primitive yet -- but split_suggestion_a/b give a human a head start
-- on the manual fix instead of starting from nothing.
-- ============================================================

CREATE TABLE IF NOT EXISTS talent_name_reviews (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_name      TEXT        NOT NULL,
  name_key            TEXT        NOT NULL,  -- lower(trim(candidate_name)); lookup/uniqueness
  talent_id           UUID        REFERENCES talent(id) ON DELETE SET NULL,  -- existing row, if any
  flag_reason         TEXT        NOT NULL,  -- 'suspicious_name' | 'ambiguous_name'
  flag_detail         TEXT,

  status              TEXT        NOT NULL DEFAULT 'pending',
                      -- 'pending', 'resolved_real', 'resolved_split',
                      -- 'resolved_uncertain', 'manually_resolved'
  verdict_confidence  TEXT,        -- 'high' | 'medium' | 'low'
  split_suggestion_a  TEXT,
  split_suggestion_b  TEXT,
  evidence_url        TEXT,
  reasoning           TEXT,
  resolved_by         TEXT,        -- 'claude_web_search' | 'claude_reasoning' | 'manual'
  resolved_at         TIMESTAMPTZ,
  used_web_search     BOOLEAN,     -- detected from response shape, not self-reported; NULL until resolved

  first_flagged_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_flagged_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (name_key)
);

CREATE INDEX IF NOT EXISTS idx_talent_name_reviews_status ON talent_name_reviews(status);

ALTER TABLE talent_name_reviews ENABLE ROW LEVEL SECURITY;
REVOKE TRUNCATE ON talent_name_reviews FROM anon, authenticated;
GRANT ALL ON talent_name_reviews TO service_role;

-- ── Seed from the current dry-run backlog ────────────────────────────
-- Re-runs reconstruct_talent_from_sightings() fresh rather than hand-
-- transcribing the pasted output -- avoids transcription drift and
-- naturally reflects whatever's actually flagged right now.
INSERT INTO talent_name_reviews (candidate_name, name_key, talent_id, flag_reason, flag_detail)
SELECT talent_name, lower(trim(talent_name)), talent_id, change_type, detail
FROM reconstruct_talent_from_sightings()
WHERE change_type IN ('suspicious_name', 'ambiguous_name')
ON CONFLICT (name_key) DO UPDATE SET
  flag_detail     = EXCLUDED.flag_detail,
  last_flagged_at = now();

-- Safe to re-run: if talent_name_reviews already exists from an earlier
-- version of this migration (before used_web_search was added), this
-- adds it without erroring on the CREATE TABLE above.
ALTER TABLE talent_name_reviews ADD COLUMN IF NOT EXISTS used_web_search BOOLEAN;