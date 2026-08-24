// Local-first message store. This device holds the chat history; the server is a
// sync transport that carries ciphertext it cannot read.
//
// Two kinds of data live here, both opaque at rest:
//
//   messages       stored as the exact sealed envelope that goes over the wire.
//                  Opening one needs the conversation key, which needs the seed,
//                  which needs the PIN -- so no re-encryption layer is added.
//   everything else  (peer usernames, conversation metadata, drafts, cursors)
//                  sealed under the seed-derived local database key.
//
// Only the fields the indexes need -- ids, timestamps, and flags -- are stored in
// the clear, so a dumped IndexedDB reveals that conversations exist and when they
// were active, but nothing about who is in them or what was said.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_META,
  STORE_PEERS,
  timberDb,
} from "./timberDb.js";
import { base64ToBytes, bytesToBase64, bytesToUtf8, randomBytes, utf8ToBytes } from "../crypto/bytes.js";
import { conversationKey, open as openEnvelope, seal } from "../crypto/envelope.js";
import { currentIdentity } from "../crypto/session.js";
import { verifyKexKeyBinding } from "../crypto/identity.js";

const NONCE_BYTES = 24;
const MAX_CALL_SIGNAL_CIPHERTEXT_BYTES = 48 * 1024;

/** Seal an arbitrary value under the device key, for metadata at rest. */
function sealLocal(value) {
  const { localDbKey } = currentIdentity();
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(localDbKey, nonce).encrypt(
    utf8ToBytes(JSON.stringify(value)),
  );
  return { n: bytesToBase64(nonce), c: bytesToBase64(ciphertext) };
}

function openLocal(sealed) {
  if (!sealed) return null;
  const { localDbKey } = currentIdentity();
  const plaintext = xchacha20poly1305(localDbKey, base64ToBytes(sealed.n)).decrypt(
    base64ToBytes(sealed.c),
  );
  return JSON.parse(bytesToUtf8(plaintext));
}

// --- peers -----------------------------------------------------------------

export class PeerKeyVerificationError extends Error {
  constructor(message = "This contact's identity key could not be verified. Messaging is blocked to protect your conversation.", retainExisting = false) {
    super(message);
    this.name = "PeerKeyVerificationError";
    this.retainExisting = retainExisting;
  }
}

/** Cache a peer's profile and public keys so chats render while offline. */
export async function putPeer(peer) {
  if (!verifyKexKeyBinding({
    userId: peer.id,
    identityPk: peer.identity_pk,
    kexPk: peer.kex_pk,
    kexKeySignature: peer.kex_key_signature,
  })) {
    throw new PeerKeyVerificationError();
  }
  const db = await timberDb();
  const existing = await db.get(STORE_PEERS, peer.id);
  if (existing) {
    const trusted = openLocal(existing.data);
    if (trusted.identity_pk !== peer.identity_pk || trusted.kex_pk !== peer.kex_pk) {
      throw new PeerKeyVerificationError(
        "This contact's identity key changed unexpectedly. Compare safety numbers before messaging again.",
        true,
      );
    }
  }
  await db.put(STORE_PEERS, { id: peer.id, data: sealLocal(peer) });
}

export async function getPeer(userId) {
  const db = await timberDb();
  const record = await db.get(STORE_PEERS, userId);
  return record ? openLocal(record.data) : null;
}

/** Remove any stale or untrusted peer key before it can be used for ECDH. */
export async function deletePeer(userId) {
  const db = await timberDb();
  await db.delete(STORE_PEERS, userId);
}

export async function allPeers() {
  const db = await timberDb();
  return (await db.getAll(STORE_PEERS)).map((record) => openLocal(record.data));
}

// --- conversations ---------------------------------------------------------

export async function upsertConversation(conversation) {
  const db = await timberDb();
  const existing = await db.get(STORE_CONVERSATIONS, conversation.id);
  const merged = { ...(existing ? openLocal(existing.data) : {}), ...conversation };
  await db.put(STORE_CONVERSATIONS, {
    id: conversation.id,
    updatedAt: conversation.updatedAt ?? existing?.updatedAt ?? 0,
    data: sealLocal(merged),
  });
  return merged;
}

export async function getConversation(conversationId) {
  const db = await timberDb();
  const record = await db.get(STORE_CONVERSATIONS, conversationId);
  return record ? openLocal(record.data) : null;
}

/** Conversations most-recently-active first, the order the Chats tab renders. */
export async function listConversations() {
  const db = await timberDb();
  const records = await db.getAll(STORE_CONVERSATIONS);
  return records
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map((record) => openLocal(record.data));
}

export async function touchConversation(conversationId, updatedAt) {
  const db = await timberDb();
  const record = await db.get(STORE_CONVERSATIONS, conversationId);
  if (record && (record.updatedAt ?? 0) < updatedAt) {
    await db.put(STORE_CONVERSATIONS, { ...record, updatedAt });
  }
}

/** Remove a conversation and its local ciphertext when the friendship is removed. */
export async function deleteConversation(conversationId, peerId = null) {
  const db = await timberDb();
  const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES, STORE_PEERS], "readwrite");
  const messages = tx.objectStore(STORE_MESSAGES);
  const range = IDBKeyRange.bound(
    [conversationId, Number.MIN_SAFE_INTEGER],
    [conversationId, Number.MAX_SAFE_INTEGER],
  );
  let cursor = await messages.index("byConversation").openCursor(range);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.objectStore(STORE_CONVERSATIONS).delete(conversationId);
  if (peerId) await tx.objectStore(STORE_PEERS).delete(peerId);
  await tx.done;
}

// --- conversation keys -----------------------------------------------------

/**
 * Resolve the symmetric key for a conversation from the locally cached peer.
 * Returns null when the peer's public key has not been fetched yet, which is
 * what lets callers show "waiting to sync" instead of failing outright.
 */
export async function keyForConversation(conversationId) {
  const identity = currentIdentity();
  const conversation = await getConversation(conversationId);
  if (!conversation || conversation.securityError) return null;
  const peer = await getPeer(conversation.peerId);
  if (!peer?.kex_pk) return null;

  return conversationKey({
    conversationId,
    kexSk: identity.kexSk,
    peerKexPk: peer.kex_pk,
    userId: identity.userId,
    peerUserId: peer.id,
  });
}

/** Seal transient WebRTC signalling with the same conversation key as chat.
 * Unlike messages, these envelopes are never written to IndexedDB. */
export async function sealCallSignal(conversationId, payload) {
  const identity = currentIdentity();
  const key = await keyForConversation(conversationId);
  if (!key) throw new Error("This conversation is not ready for a secure call.");
  return seal({
    key,
    conversationId,
    senderId: identity.userId,
    payload,
    maxCiphertextBytes: MAX_CALL_SIGNAL_CIPHERTEXT_BYTES,
  });
}

/** Open a short-lived encrypted SDP or ICE signal delivered by the relay. */
export async function openCallSignal(conversationId, senderId, envelope) {
  const key = await keyForConversation(conversationId);
  if (!key) throw new Error("This conversation is not ready for a secure call.");
  return openEnvelope({ key, conversationId, senderId, envelope });
}

// --- messages --------------------------------------------------------------

/**
 * Persist a sealed message.
 *
 * `pending` marks a message written optimistically that the server has not yet
 * acknowledged; the outbox retries these on reconnect. IndexedDB indexes cannot
 * key on booleans, so it is stored as 0/1.
 */
export async function putMessage(message) {
  const db = await timberDb();
  const record = {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    createdAt: message.createdAt,
    pending: message.pending ? 1 : 0,
    read: message.read ? 1 : 0,
    envelope: message.envelope,
  };
  await db.put(STORE_MESSAGES, record);
  await touchConversation(message.conversationId, message.createdAt);
  return record;
}

/** Replace an optimistic message once the server assigns its real id. */
export async function confirmMessage(temporaryId, confirmed) {
  const db = await timberDb();
  await db.delete(STORE_MESSAGES, temporaryId);
  return putMessage({ ...confirmed, pending: false });
}

export async function getMessage(messageId) {
  const db = await timberDb();
  return db.get(STORE_MESSAGES, messageId);
}

/**
 * Read a page of a conversation, newest last.
 *
 * Each row is decrypted here rather than at render time so the UI never handles
 * ciphertext. A row that fails to open is surfaced as `undecryptable` instead of
 * being dropped, so tampering or a key mismatch is visible rather than silent.
 */
export async function messagesFor(conversationId, { before = null, limit = 50 } = {}) {
  const db = await timberDb();
  const upper = before ?? Number.MAX_SAFE_INTEGER;
  const range = IDBKeyRange.bound(
    [conversationId, Number.MIN_SAFE_INTEGER],
    [conversationId, upper],
    false,
    true,
  );

  const index = db.transaction(STORE_MESSAGES).store.index("byConversation");
  const page = [];
  let cursor = await index.openCursor(range, "prev");
  while (cursor && page.length < limit) {
    page.push(cursor.value);
    cursor = await cursor.continue();
  }
  page.reverse();

  const key = await keyForConversation(conversationId);
  return page.map((record) => decryptRecord(record, conversationId, key));
}

/**
 * Apply encrypted control envelopes locally. The relay only sees a sequence of
 * opaque messages; edits, retractions, reactions, pins, votes, and expiry are
 * interpreted only after the conversation key has opened each envelope.
 */
export function presentMessages(messages, now = Date.now()) {
  const visible = new Map();
  const order = [];
  for (const message of messages) {
    if (message.undecryptable) {
      visible.set(message.id, message);
      order.push(message.id);
      continue;
    }
    const payload = message.payload ?? {};
    const target = payload.message_id ?? payload.decision_id;
    if (payload.t === "reaction") {
      const original = visible.get(target);
      if (original && !original.undecryptable) {
        const reactions = { ...(original.reactions ?? {}) };
        const people = new Set(reactions[payload.emoji] ?? []);
        people.add(message.senderId);
        original.reactions = { ...reactions, [payload.emoji]: [...people] };
      }
      continue;
    }
    if (payload.t === "edit" || payload.t === "delete" || payload.t === "pin") {
      const original = visible.get(target);
      if (original && !original.undecryptable) {
        // Only an author can alter or retract their own message. Pins are a
        // mutual conversation feature, so either participant may add/remove one.
        if (payload.t === "edit" && original.senderId === message.senderId && typeof payload.body === "string") {
          original.payload = { ...original.payload, body: payload.body, edited: true };
        }
        if (payload.t === "delete" && original.senderId === message.senderId) {
          original.deleted = true;
          original.payload = { ...original.payload, body: "" };
        }
        if (payload.t === "pin") original.pinned = Boolean(payload.pinned);
      }
      continue;
    }
    if (payload.t === "decision_vote") {
      const original = visible.get(target);
      if (original && original.payload?.t === "decision") {
        const votes = { ...(original.votes ?? {}) };
        votes[message.senderId] = payload.value;
        original.votes = votes;
      }
      continue;
    }
    if (payload.t === "call_update") {
      const original = [...visible.values()].find((entry) => (
        entry.payload?.t === "call" && entry.payload.call_id === payload.call_id
      ));
      // A call card has one author: the person who placed the call. The peer can
      // signal its outcome, but cannot forge or rewrite the encrypted history.
      if (original && original.senderId === message.senderId) {
        original.payload = {
          ...original.payload,
          status: payload.status,
          ...(Number.isFinite(payload.duration_ms) ? { duration_ms: payload.duration_ms } : {}),
        };
      }
      continue;
    }
    const entry = { ...message, payload: { ...payload } };
    if (payload.expires_at && new Date(payload.expires_at).getTime() <= now) {
      entry.expired = true;
      entry.payload = { ...entry.payload, body: "" };
    }
    visible.set(message.id, entry);
    order.push(message.id);
  }
  return order.map((id) => visible.get(id)).filter(Boolean);
}

function decryptRecord(record, conversationId, key) {
  const base = {
    id: record.id,
    conversationId: record.conversationId,
    senderId: record.senderId,
    createdAt: record.createdAt,
    pending: record.pending === 1,
    read: record.read === 1,
  };
  if (!key) return { ...base, undecryptable: true, reason: "waiting-for-key" };
  try {
    return { ...base, payload: openEnvelope({
      key,
      conversationId,
      senderId: record.senderId,
      envelope: record.envelope,
    }) };
  } catch {
    return { ...base, undecryptable: true, reason: "verification-failed" };
  }
}

/** The newest message in a conversation, for the chat list preview. */
export async function lastMessage(conversationId) {
  const [message] = await messagesFor(conversationId, { limit: 1 });
  return message ?? null;
}

/** Seal and store a message this device is sending. */
export async function composeMessage({ conversationId, payload, id, createdAt = Date.now() }) {
  const identity = currentIdentity();
  const key = await keyForConversation(conversationId);
  if (!key) throw new Error("This conversation is not ready to send yet.");

  const envelope = seal({
    key,
    conversationId,
    senderId: identity.userId,
    payload,
  });
  await putMessage({
    id,
    conversationId,
    senderId: identity.userId,
    createdAt,
    pending: true,
    read: true,
    envelope,
  });
  return envelope;
}

export async function unreadCount(conversationId) {
  const db = await timberDb();
  const identity = currentIdentity();
  const range = IDBKeyRange.bound(
    [conversationId, Number.MIN_SAFE_INTEGER],
    [conversationId, Number.MAX_SAFE_INTEGER],
  );
  const index = db.transaction(STORE_MESSAGES).store.index("byConversation");
  let count = 0;
  let cursor = await index.openCursor(range);
  while (cursor) {
    if (cursor.value.read === 0 && cursor.value.senderId !== identity.userId) count += 1;
    cursor = await cursor.continue();
  }
  return count;
}

export async function markRead(conversationId) {
  const db = await timberDb();
  const tx = db.transaction(STORE_MESSAGES, "readwrite");
  const range = IDBKeyRange.bound(
    [conversationId, Number.MIN_SAFE_INTEGER],
    [conversationId, Number.MAX_SAFE_INTEGER],
  );
  const marked = [];
  let cursor = await tx.store.index("byConversation").openCursor(range);
  while (cursor) {
    if (cursor.value.read === 0) {
      marked.push(cursor.value.id);
      await cursor.update({ ...cursor.value, read: 1 });
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return marked;
}

/** Messages awaiting delivery, oldest first, for the reconnect outbox. */
export async function pendingMessages() {
  const db = await timberDb();
  const records = await db.getAllFromIndex(STORE_MESSAGES, "byPending", 1);
  return records.sort((a, b) => a.createdAt - b.createdAt);
}

const SAVED_MESSAGES_META_KEY = "saved-messages";

/** Saved messages are an encrypted, device-local list, never a server feature. */
export async function toggleSavedMessage(message) {
  const saved = (await getMeta(SAVED_MESSAGES_META_KEY)) ?? [];
  const exists = saved.some((entry) => entry.id === message.id);
  const next = exists
    ? saved.filter((entry) => entry.id !== message.id)
    : [...saved, { id: message.id, conversationId: message.conversationId }];
  await setMeta(SAVED_MESSAGES_META_KEY, next);
  return !exists;
}

export async function savedMessageIds() {
  return new Set(((await getMeta(SAVED_MESSAGES_META_KEY)) ?? []).map((entry) => entry.id));
}

/** Read the encrypted device-local saved-message collection on demand. */
export async function savedMessages() {
  const entries = (await getMeta(SAVED_MESSAGES_META_KEY)) ?? [];
  const results = [];
  for (const entry of entries) {
    const record = await getMessage(entry.id);
    if (!record || record.conversationId !== entry.conversationId) continue;
    results.push(decryptRecord(record, entry.conversationId, await keyForConversation(entry.conversationId)));
  }
  return results.filter((message) => !message.undecryptable).sort((a, b) => b.createdAt - a.createdAt);
}

function searchableText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const values = [];
  for (const key of ["body", "name", "mime", "prompt", "kind"]) {
    if (typeof payload[key] === "string") values.push(payload[key]);
  }
  if (Array.isArray(payload.options)) values.push(...payload.options.filter((value) => typeof value === "string"));
  return values.join(" ").toLowerCase();
}

/**
 * Private, on-device full-text search. It deliberately scans encrypted rows at
 * query time instead of writing a plaintext index into IndexedDB.
 */
export async function searchMessages(query, { limit = 100 } = {}) {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  const db = await timberDb();
  const records = await db.getAll(STORE_MESSAGES);
  const keys = new Map();
  const matches = [];
  for (const record of records) {
    let key = keys.get(record.conversationId);
    if (key === undefined) {
      key = await keyForConversation(record.conversationId);
      keys.set(record.conversationId, key);
    }
    const message = decryptRecord(record, record.conversationId, key);
    if (!message.undecryptable && searchableText(message.payload).includes(term)) matches.push(message);
  }
  return matches.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

// --- sync cursors ----------------------------------------------------------

export async function getMeta(key) {
  const db = await timberDb();
  const record = await db.get(STORE_META, key);
  return record ? openLocal(record) : null;
}

export async function setMeta(key, value) {
  const db = await timberDb();
  await db.put(STORE_META, sealLocal(value), key);
}
