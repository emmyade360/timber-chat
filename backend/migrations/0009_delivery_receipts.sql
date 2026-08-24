-- Delivery receipts.
--
-- A message has three observable states for its sender: stored by the relay
-- (one tick), handed to the recipient's device (two), and opened by the
-- recipient (three). Read was already tracked in read_receipts; this adds the
-- middle state.
--
-- A direct message has exactly one recipient, so delivery is a single nullable
-- timestamp on the row rather than a receipts table. It records only *that* the
-- ciphertext reached the other device -- never anything about its contents.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- Backfill: everything already read was self-evidently delivered. Without this
-- older conversations would drop back to one tick the first time they reload.
UPDATE messages m
SET delivered_at = r.created_at
FROM read_receipts r
WHERE r.message_id = m.id
  AND r.user_id <> m.sender_id
  AND m.delivered_at IS NULL;

-- Supports the recipient's "what have I not acknowledged yet" sweep on connect.
CREATE INDEX IF NOT EXISTS messages_undelivered_idx
    ON messages (conversation_id, sender_id)
    WHERE delivered_at IS NULL;
