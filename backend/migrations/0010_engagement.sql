-- Engagement mechanics: per-friendship streaks, and growth that responds to
-- ordinary use.
--
-- This migration reverses a deliberate earlier decision. Growth was built to be
-- unfarmable -- capped at 44 points a day, roughly a year to the top stage, and
-- explicitly never awarded for message volume, popularity or referrals. That
-- design is being replaced with conventional engagement mechanics, so the
-- product's own documentation (README.md, growth.rs, levels.rs) has been
-- rewritten in the same change rather than left describing a promise the code
-- no longer keeps.

-- A streak belongs to a pair, not a person, and only advances on a day both
-- people sent something. Canonical ordering plus the primary key makes a
-- duplicate row impossible, the same way `conversations` does.
CREATE TABLE IF NOT EXISTS friendship_streaks (
    user_a UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    user_b UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    days INTEGER NOT NULL DEFAULT 0 CHECK (days >= 0),
    -- The most recent day on which both sides sent. NULL until that happens.
    last_mutual_day DATE,
    -- The last day each side sent anything, which is how "both, today" is known.
    a_sent_on DATE,
    b_sent_on DATE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_a, user_b),
    CONSTRAINT friendship_streaks_canonical_order CHECK (user_a < user_b)
);

CREATE INDEX IF NOT EXISTS friendship_streaks_by_user_a_idx ON friendship_streaks (user_a);
CREATE INDEX IF NOT EXISTS friendship_streaks_by_user_b_idx ON friendship_streaks (user_b);

-- Opting into a public position. Growth points were private before this; a
-- leaderboard makes them comparable, so it is off unless someone asks for it.
ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS leaderboard_opt_in BOOLEAN NOT NULL DEFAULT FALSE;

-- Ranking reads only rows that opted in, and only ever needs the top slice.
CREATE INDEX IF NOT EXISTS profiles_leaderboard_idx
    ON profiles (growth_points DESC)
    WHERE leaderboard_opt_in = TRUE;
