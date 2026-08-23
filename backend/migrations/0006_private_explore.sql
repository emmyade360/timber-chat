-- Opt-in discovery is intentionally separate from encrypted chat data.  These
-- fields are public to eligible people shown an Explore card; no coordinates,
-- presence, contact graph, safety numbers, or message content are stored here.

CREATE TABLE explore_profiles (
    user_id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    adult_attested_at TIMESTAMPTZ NOT NULL,
    is_visible BOOLEAN NOT NULL DEFAULT FALSE,
    photo_url TEXT,
    bio VARCHAR(160) NOT NULL DEFAULT '',
    -- A self-selected, normalized matching bucket. It is never returned in a
    -- card response or rendered to other users.
    metro_area VARCHAR(64) NOT NULL,
    interests TEXT[] NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT explore_profile_metro_length CHECK (char_length(metro_area) BETWEEN 2 AND 64),
    CONSTRAINT explore_profile_interest_count CHECK (cardinality(interests) BETWEEN 1 AND 5)
);

CREATE INDEX explore_profiles_visible_metro_idx
    ON explore_profiles (metro_area, updated_at DESC)
    WHERE is_visible = TRUE;

CREATE TABLE explore_likes (
    actor_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK (decision IN ('liked', 'passed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (actor_id, target_id),
    CONSTRAINT explore_likes_not_self CHECK (actor_id <> target_id)
);

CREATE INDEX explore_likes_target_decision_idx ON explore_likes (target_id, decision);

CREATE TABLE explore_blocks (
    actor_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (actor_id, target_id),
    CONSTRAINT explore_blocks_not_self CHECK (actor_id <> target_id)
);

-- Reports remain available to a human moderation process even after a user
-- opts out and their discovery profile is removed from visibility.
CREATE TABLE explore_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
    target_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL CHECK (reason IN ('harassment', 'impersonation', 'unsafe', 'other')),
    details VARCHAR(500),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'resolved')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT explore_reports_not_self CHECK (reporter_id <> target_id)
);

CREATE INDEX explore_reports_review_queue_idx ON explore_reports (status, created_at ASC);

CREATE TABLE explore_matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_a UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    user_b UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT explore_matches_ordered CHECK (user_a < user_b),
    CONSTRAINT explore_matches_unique_pair UNIQUE (user_a, user_b)
);

CREATE INDEX explore_matches_user_a_idx ON explore_matches (user_a, created_at DESC);
CREATE INDEX explore_matches_user_b_idx ON explore_matches (user_b, created_at DESC);
