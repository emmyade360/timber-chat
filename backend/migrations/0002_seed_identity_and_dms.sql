-- Rebuild Timber around non-custodial identity and end-to-end encrypted DMs.
--
-- This migration is destructive by necessity. The old `messages.content` column held
-- plaintext, and there is no key on the server capable of re-sealing it for the new
-- scheme -- only the participants' devices could do that, and they never had keys.
-- Public rooms and group membership are dropped along with it: the product is now
-- strictly one-to-one between two people who have accepted each other as friends.

DROP TABLE IF EXISTS join_requests;
DROP TABLE IF EXISTS read_receipts;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS room_members;
DROP TABLE IF EXISTS rooms;
DROP TABLE IF EXISTS friend_requests;
DROP TABLE IF EXISTS profiles;

-- Identity. `id` is not random: it is derived from identity_pk by the same rule on
-- both client and server (UUIDv8 over SHA-256 of the key), so an account is a pure
-- function of its recovery phrase and nothing needs to be looked up to find it.
CREATE TABLE profiles (
    id UUID PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    identity_pk BYTEA NOT NULL UNIQUE,          -- Ed25519 public key, 32 bytes
    kex_pk BYTEA NOT NULL,                      -- X25519 public key, 32 bytes
    avatar_url TEXT,
    xp BIGINT NOT NULL DEFAULT 0,
    level SMALLINT NOT NULL DEFAULT 1,
    streak_days INTEGER NOT NULL DEFAULT 0,
    last_active_date DATE,
    is_online BOOLEAN NOT NULL DEFAULT FALSE,
    last_seen TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT profiles_identity_pk_len CHECK (octet_length(identity_pk) = 32),
    CONSTRAINT profiles_kex_pk_len CHECK (octet_length(kex_pk) = 32),
    CONSTRAINT profiles_level_range CHECK (level BETWEEN 1 AND 21),
    CONSTRAINT profiles_xp_positive CHECK (xp >= 0),
    -- Claimed once, immutable, and safe to show: 3-20 chars, lowercase, no spoofing
    -- room via mixed case or punctuation.
    CONSTRAINT profiles_username_shape CHECK (username ~ '^[a-z0-9_]{3,20}$')
);

-- Login challenges. Short-lived nonces the client signs to prove key possession.
CREATE TABLE auth_challenges (
    identity_pk BYTEA PRIMARY KEY,
    nonce BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX auth_challenges_expiry_idx ON auth_challenges (expires_at);

-- Friendship, with the two-strike rule. A rejected sender gets exactly one more
-- attempt; a second rejection moves the row to 'blocked', which is terminal and
-- also removes the receiver from the sender's search results.
CREATE TABLE friend_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    receiver_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected', 'blocked')),
    attempts SMALLINT NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (sender_id <> receiver_id),
    UNIQUE (sender_id, receiver_id)
);
CREATE INDEX friend_requests_by_receiver_status_idx ON friend_requests (receiver_id, status);
CREATE INDEX friend_requests_by_sender_status_idx ON friend_requests (sender_id, status);

-- One conversation per pair of people, enforced by the schema rather than by
-- application code. Canonical ordering (user_a < user_b) plus UNIQUE makes a
-- duplicate DM impossible even under a race between two simultaneous accepts.
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_a UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    user_b UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT conversations_canonical_order CHECK (user_a < user_b),
    UNIQUE (user_a, user_b)
);
CREATE INDEX conversations_by_user_a_idx ON conversations (user_a);
CREATE INDEX conversations_by_user_b_idx ON conversations (user_b);

-- Messages. There is deliberately no plaintext column: the server stores a sealed
-- envelope and the metadata needed to route and order it, and nothing else. The
-- ciphertext is authenticated against (conversation_id, sender_id) on the client,
-- so the server cannot move a message between conversations or re-attribute it
-- without the tampering being detected.
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    envelope_version SMALLINT NOT NULL DEFAULT 1,
    nonce BYTEA NOT NULL,
    ciphertext BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT messages_nonce_len CHECK (octet_length(nonce) = 24),
    CONSTRAINT messages_ciphertext_bounds
        CHECK (octet_length(ciphertext) > 0 AND octet_length(ciphertext) <= 8192)
);
CREATE INDEX messages_by_conversation_created_idx ON messages (conversation_id, created_at);

CREATE TABLE read_receipts (
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_id, user_id)
);

-- Per-day, per-source XP subtotals. The primary key is what enforces the daily
-- caps: awards upsert into a row and clamp, so no amount of activity in one day
-- can exceed the cap for that source. This is the whole difficulty mechanic.
CREATE TABLE xp_daily (
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    kind TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
    PRIMARY KEY (user_id, day, kind)
);
