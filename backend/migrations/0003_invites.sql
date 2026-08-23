-- Invite links and referrals.
--
-- Growing the ladder by messaging alone is capped at a trickle by design. Bringing
-- people in is the one source that scales, so every account gets a shareable code
-- and both sides earn XP when it is used.

ALTER TABLE profiles ADD COLUMN invite_code TEXT;

-- Backfill any accounts that predate this migration. The generated value is
-- uppercase hex, which is inside the character set the constraint allows.
UPDATE profiles
SET invite_code = upper(substr(md5(id::text || clock_timestamp()::text), 1, 8))
WHERE invite_code IS NULL;

ALTER TABLE profiles
    ALTER COLUMN invite_code SET NOT NULL,
    ADD CONSTRAINT profiles_invite_code_unique UNIQUE (invite_code),
    -- Ambiguous glyphs (0/O, 1/I/L) are excluded when codes are generated, so a
    -- code read aloud or copied by hand cannot land on a different account.
    ADD CONSTRAINT profiles_invite_code_shape CHECK (invite_code ~ '^[A-Z0-9]{6,12}$');

-- One row per person brought in. The primary key on invited_id enforces the rule
-- that an account can only ever be credited to a single referrer.
CREATE TABLE referrals (
    invited_id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    referrer_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (invited_id <> referrer_id)
);
CREATE INDEX referrals_by_referrer_idx ON referrals (referrer_id, created_at DESC);
