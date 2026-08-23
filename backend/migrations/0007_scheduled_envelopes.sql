-- Delivery time is the only scheduled-message metadata visible to the relay.
-- The body remains the same authenticated envelope stored in `messages` once due.
CREATE TABLE scheduled_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    envelope_version SMALLINT NOT NULL CHECK (envelope_version IN (1, 2)),
    nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 24),
    ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) > 0 AND octet_length(ciphertext) <= 8192),
    client_id VARCHAR(96),
    deliver_after TIMESTAMPTZ NOT NULL,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX scheduled_messages_due_idx
    ON scheduled_messages (deliver_after)
    WHERE delivered_at IS NULL;
