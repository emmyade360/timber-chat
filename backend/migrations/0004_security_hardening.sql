-- Security hardening for the non-custodial protocol.  This migration is
-- forward-only: existing 12-word accounts keep their identity, then attest the
-- deterministic X25519 key derived from that identity on their next sign-in.

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS kex_key_signature BYTEA;

ALTER TABLE profiles
    ADD CONSTRAINT profiles_kex_key_signature_len
        CHECK (kex_key_signature IS NULL OR octet_length(kex_key_signature) = 64);

-- Access tokens are random opaque values.  The database keeps only a SHA-256
-- digest, so a database dump cannot be replayed as a session credential.
CREATE TABLE auth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_digest BYTEA NOT NULL UNIQUE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT auth_sessions_digest_len CHECK (octet_length(token_digest) = 32)
);
CREATE INDEX auth_sessions_active_user_idx
    ON auth_sessions (user_id, expires_at) WHERE revoked_at IS NULL;

-- Browser WebSocket APIs cannot send an Authorization header.  A short-lived,
-- single-use ticket avoids putting an access token in a URL or log line.
CREATE TABLE ws_tickets (
    token_digest BYTEA PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ws_tickets_digest_len CHECK (octet_length(token_digest) = 32)
);
CREATE INDEX ws_tickets_expiry_idx ON ws_tickets (expires_at);

-- Attachment bytes are encrypted before upload and live in a private bucket.
-- The staging row lets the relay authorize the final download without reading the
-- encrypted message payload that names the attachment.
CREATE TABLE attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    object_key UUID NOT NULL UNIQUE,
    message_id UUID UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX attachments_expiry_idx ON attachments (expires_at) WHERE message_id IS NULL;
