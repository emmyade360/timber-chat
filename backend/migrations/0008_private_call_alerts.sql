-- Short-lived, opaque WebRTC signalling for an incoming call. SDP and ICE are
-- encrypted with the conversation key before they reach this table; neither
-- Timber nor the push service can open them.
CREATE TABLE pending_calls (
    call_id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    caller_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    media TEXT NOT NULL CHECK (media IN ('audio', 'video')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (caller_id <> recipient_id)
);
CREATE INDEX pending_calls_recipient_expiry_idx ON pending_calls (recipient_id, expires_at);

CREATE TABLE pending_call_signals (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    call_id UUID NOT NULL REFERENCES pending_calls(call_id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('offer', 'answer', 'ice-candidate')),
    envelope_version SMALLINT NOT NULL CHECK (envelope_version IN (1, 2)),
    nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 24),
    ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) > 0 AND octet_length(ciphertext) <= 49152),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX pending_call_signals_call_idx ON pending_call_signals (call_id, id);

-- Push subscription keys identify a browser installation. They are not account
-- keys, are used only to encrypt a platform notification, and can be deleted by
-- the device or automatically after a permanent provider failure.
CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    p256dh TEXT NOT NULL CHECK (char_length(p256dh) BETWEEN 16 AND 512),
    auth TEXT NOT NULL CHECK (char_length(auth) BETWEEN 8 AND 256),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);
