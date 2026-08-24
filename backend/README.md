# Timber backend

Axum + SQLx over Postgres. It authenticates signatures, enforces the friendship
rules, routes sealed envelopes, and tracks progression. It cannot read a message:
there is no plaintext column in the schema and no decryption key in the process.

## Layout

| Module | Responsibility |
| --- | --- |
| `auth.rs` | Challenge/response login, key attestation, opaque session and socket tickets |
| `levels.rs` | The 21-stage connection-growth path and stage resolution |
| `growth.rs` | Awarding bounded, consent-based connection growth |
| `models.rs` | Row and wire types (none of which can carry message text) |
| `ws.rs` | One websocket per user; opaque sends, scheduled delivery, typing, receipts, presence |
| `routes/webrtc.rs` | Authenticated STUN/TURN configuration and short-lived coturn credentials |
| `routes/` | `friends`, `conversations`, `explore`, `users`, `upload` |

## Authentication

No passwords. An account is an Ed25519 public key, and the account id is
`UUIDv8(SHA-256(public key))` — derived the same way on both sides, so the mapping
needs no lookup table and no server-assigned identifier.

1. `POST /auth/challenge { identity_pk }` → a 32-byte nonce, valid 120s.
2. Client signs the nonce with the key derived from its recovery phrase.
3. `POST /auth/register` includes an Ed25519 signature binding the deterministic
   X25519 key to the account; clients reject peers without that proof.
4. `POST /auth/register` or `POST /auth/login` exchanges the signature for a
   revocable, opaque bearer session valid for 15 minutes.

Challenges use a server-generated 32-byte CSPRNG nonce and are deleted only after
a valid signature. An invalid request cannot consume or replace a live challenge
for a public identity key; successful nonces are strictly single-use. Timber never
stores, receives, or returns BIP39 words or word hashes.

`POST /api/ws-ticket` exchanges a valid bearer for a one-time 60-second ticket.
The browser offers it with the `timber-v1` WebSocket subprotocol; no long-lived
credential appears in a URL. `POST /api/auth/logout` revokes the current session.

## WebRTC calls

`GET /api/webrtc/ice-servers` returns deployment-provided STUN/TURN configuration only
to an authenticated account. When `WEBRTC_TURN_SHARED_SECRET` is set, it returns a
ten-minute account-scoped coturn REST credential rather than a long-lived relay secret.
`call.offer`, `call.answer`, `call.ice-candidate`, and `call.end` are authenticated
WebSocket events. Each is authorized against an accepted 1:1 conversation, rate-limited,
and relayed only to the other participant. SDP and ICE are sealed with the conversation
key before relay; a pending encrypted setup record can exist for at most 60 seconds to
wake an installed PWA, then is deleted. Plaintext signaling is neither stored nor logged.

Audio/video itself does not enter this service. Browsers use WebRTC DTLS-SRTP directly,
or encrypted through the configured TURN relay. Production needs explicit STUN/TURN
configuration for reliable calls across NATs and HTTPS/WSS for browser media permission.

## The two-strike friendship rule

| State | Sender asks again | Receiver declines |
| --- | --- | --- |
| none | → `pending` (attempt 1) | → `rejected` |
| `rejected`, attempt 1 | → `pending` (attempt 2) | → `blocked` |
| `blocked` | 403, and the receiver is gone from their search | — |

The block is directional. The receiver can still find the sender and start their own
request if they change their mind.

## Invites

`GET /api/invite` returns the caller's code and joining count. `GET /invites/{code}` is
public so an invite landing page can name the inviter before the visitor has an account.

Redemption happens during registration and is deliberately forgiving: a code that does not
resolve is ignored rather than failing the signup, because the account is already valid and
losing it to a mistyped link would be the worse outcome. Redemption also creates the
friendship and conversation — unless either side has blocked the other, so an invite link
cannot be used to route around a block.

Invites confer no growth, status, or referral reward.

## Explore

`/api/explore/*` is protected and intentionally separate from chat envelopes. A visible
card contains only a public HTTPS photo URL, short bio, and controlled interests. The
matching metro remains write-only, no coordinates are collected, and card payloads never
include presence, last-seen, safety numbers, or social-graph data. Rate limits cap card
refreshes, likes, passes, reports, and profile changes. Mutual likes create the existing
accepted friend relationship and conversation only when both profiles have an attested
chat-key binding.

## What the server stores for a message

`(id, conversation_id, sender_id, envelope_version, nonce, ciphertext, created_at)`

The ciphertext is authenticated against `(conversation_id, sender_id)` on the client,
so tampering with routing or attribution is detectable by the recipient.

## Supabase

Used for Postgres and object storage only — **not** for authentication. The
`chat-files` bucket must be private. Uploads are encrypted before they arrive,
stored as `application/octet-stream` under random names, and downloaded only via
an authenticated conversation-participant route with `Content-Disposition: attachment`.
The relay cannot magic-byte scan or virus-scan an E2EE ciphertext blob without
breaking the non-custodial model.
