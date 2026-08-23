# Timber

A private, non-custodial direct-message app.

- **Your account is twelve words.** No email, no password, no server-held credential.
  The phrase is generated in your browser and never leaves your device.
- **The server cannot read your messages.** Every message is sealed on the sending
  device and opened only on the receiving one. Postgres holds ciphertext and has no
  plaintext column to hold anything else.
- **Your history lives on your device**, in an encrypted local database. The server
  keeps a sealed copy so messages survive being offline and reach a restored device.
- **Direct messages only.** You claim a username, add people as friends, and only two
  people who have accepted each other can exchange messages.
- **A 21-stage growth path** from Seed to Living Grove, earned through bounded,
  consent-based connection practices — never message volume, popularity, time online,
  referral counts, or message content.

## How the encryption fits together

```
  twelve words (BIP39)
        │
        ▼  HKDF-SHA256, one domain per key
  ┌─────┴───────────────────────────────────────┐
  │ Ed25519 keypair   → signs login challenges  │
  │ X25519  keypair   → ECDH with each peer     │
  │ local database key→ encrypts metadata at rest│
  └─────────────────────────────────────────────┘

  account id = UUIDv8( SHA-256( Ed25519 public key ) )
      derived identically on client and server, so an account is a pure
      function of its phrase and nothing is assigned by us

  conversation key = HKDF( X25519(my secret, their public), sorted user ids )
      both sides compute it offline; it is never transmitted

message = XChaCha20-Poly1305( conversation key, random 24-byte nonce )
      authenticated against (conversation id, sender id), so a stored message
      cannot be replayed into another chat or re-attributed to someone else
```

**What is protected:** message text, encrypted attachments, attachment filenames,
replies, reactions, edits, decision cards, postcards, and local search terms.
**What is not:** routing metadata. The server necessarily learns account IDs,
conversation membership, message timing, attachment size, presence among accepted
friends, and scheduled-delivery time. It cannot read the associated content. For a
live call it temporarily relays SDP/ICE setup metadata and learns call timing; it
never receives, records, or stores the audio/video media.

**Forward secrecy:** not in v1. Someone who obtains your phrase can decrypt past
messages they have copies of. The envelope carries a version field so a Double
Ratchet can be added later without migrating stored data.

## Security boundary

Each X25519 chat key is signed by its Ed25519 account key. Clients verify that
binding before using a contact's key, so the relay cannot silently substitute its
own chat key. Compare a contact's safety number through another trusted channel
when the conversation is sensitive.

The server stores encrypted sync copies and routing metadata: account IDs,
conversation membership, message timing/delivery state, attachment size, scheduled
delivery time, and presence for accepted friends. It does not hold a message
decryption key. A stolen recovery phrase still exposes static-key message history
to whoever has ciphertext copies; Signal-style forward secrecy is explicitly out
of scope for this browser release.

Timber is a browser app. HTTPS code delivery and a strict CSP are therefore part
of its security boundary: a malicious deployment or an XSS flaw while the vault
is unlocked can access the phrase and plaintext. The app locks after five minutes
idle (or 30 seconds in the background), but a native client with hardware-backed
storage is required for stronger device-compromise resistance.

## Private connection features

Messages use versioned encrypted envelopes. The current client supports replies,
reactions, edits, delete-for-everyone tombstones, shared pins, private saved messages,
encrypted decision cards, text postcards that expire locally, encrypted files and voice
notes, quiet send, and encrypted scheduled delivery. Local search opens envelopes on
demand and never writes a plaintext index to IndexedDB.

One-to-one audio and video calls use WebRTC. The socket only carries authenticated,
short-lived setup messages between accepted friends; media uses WebRTC's DTLS-SRTP
transport directly between browsers, or passes through the configured TURN relay still
encrypted in transit. Audio starts as mono, noise-suppressed Opus capped at 32 kbps.
Video is opt-in and starts at 360p/15fps capped at 350 kbps. WebRTC setup can expose
network candidates to the other participant and the chosen STUN/TURN provider, so use
an operator you trust. Calls are not Timber message envelopes and are not backed up.

Browser notifications are off by default, generic (never message text), and controlled
per chat. Quiet mode stores the choice inside the encrypted payload. Optional digest and
check-in controls are device-local; a web page cannot reliably notify after it is closed.

The Restore & device-continuity center can emit a QR containing the existing
PIN-encrypted vault record, never the recovery phrase. A new device still requires that
PIN, then signs in and restores ciphertext through normal sync. Treat that QR like a
password export and hide it immediately after use.

## Explore is explicitly public

Explore is an adults-only, opt-in friend-discovery surface—not a feed, dating product,
or open-DM system. An enabled card exposes a public photo URL, 160-character bio, and up
to five controlled interests to a small deck of people with a hidden shared metro filter.
It never requests geolocation or stores coordinates, maps, distance, a city label,
online/last-seen state, safety numbers, or a contact graph. Cards and matching metadata
are **not E2EE chat content**.

Likes remain private until reciprocal. A mutual like creates the ordinary accepted
friendship and 1:1 conversation; the client still verifies the peer's signed key binding
before encrypting. Pass, block, and report immediately remove a card; reports enter a
separate moderation queue. Opting out removes the card and outstanding likes but keeps
existing friends and conversations.

## Growth

Growth is a non-medical reflection of steady, consent-based connection. Daily practices
are capped and are never awarded for message quantity, time online, presence, popularity,
or referrals. It is not a health score.

## Running it

For a production Render + Vercel deployment, follow [DEPLOYMENT.md](./DEPLOYMENT.md).
It includes exact environment variables, CORS, health checks, TURN, smoke tests, and
the current single-instance WebSocket scaling limit.

### Backend

```sh
cd backend
cp .env.example .env      # fill in the Supabase values
cargo run
```

Set `ALLOWED_ORIGINS` to the exact HTTPS frontend origin(s); wildcard CORS is
rejected. Terminate TLS in front of the backend and expose the socket as `wss://`.
Sessions are 15-minute opaque tokens held only in memory. Browser sockets use a
single-use, 60-second subprotocol ticket rather than a token in a URL.
If your database password contains `?`, `@`, or `#`, percent-encode it in the URL
(`%3F`, `%40`, `%23`) or the connection string will be silently truncated.

### WebRTC calling

For calls between ordinary networks, configure your own STUN and TURN endpoints in
`backend/.env`. A TURN service is required for reliable NAT/firewall traversal; include
both UDP and TLS/TCP URLs. With coturn, set `WEBRTC_TURN_SHARED_SECRET` to the same
`static-auth-secret` configured in coturn: Timber then mints account-scoped credentials
valid for ten minutes. The browser fetches this configuration only after authentication;
do not put a long-lived TURN credential in the frontend environment. The frontend must
be served over HTTPS and the backend socket as WSS for camera/microphone access outside
localhost.

> **Migration `0002` is destructive.** It drops the old `profiles`, `rooms`,
> `room_members`, `messages`, and `join_requests` tables. Old plaintext messages
> cannot be carried over — the server has no key to seal them with — and the old
> email accounts have no recovery phrase. Migrations run automatically on startup,
> so point the backend at an empty database unless you intend to wipe.

### Frontend

```sh
cd frontend
cp .env.example .env
npm install
npm run dev
```

## Tests

```sh
cd backend  && cargo test && cargo clippy --all-targets
cd frontend && npm test && npm run lint
```

The frontend suite covers key derivation against fixed vectors, envelope upgrade and
tamper rejection, encrypted control envelopes/search, the PIN vault including encrypted
device transfer, and the encrypted local store. The backend suite covers the growth path,
username rules, opaque token handling, key binding, and event routing.
