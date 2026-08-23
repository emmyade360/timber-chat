-- Replace the legacy XP mechanic with privacy-preserving connection growth.
-- This migration is forward-only: existing progress is scaled onto the new path so
-- users retain their approximate stage, while the old XP columns remain untouched
-- for rollback safety.

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS growth_points BIGINT NOT NULL DEFAULT 0
        CHECK (growth_points >= 0);

-- The old top threshold was 530,000 XP and the new top threshold is 13,800 growth
-- points. Scaling preserves existing accounts' approximate place on the path.
UPDATE profiles
SET growth_points = ROUND(xp::NUMERIC * 13800 / 530000)::BIGINT
WHERE growth_points = 0 AND xp > 0;

CREATE TABLE IF NOT EXISTS growth_daily (
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    kind TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
    PRIMARY KEY (user_id, day, kind)
);
