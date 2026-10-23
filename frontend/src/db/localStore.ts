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
import type { SealedLocal } from "../types/db.js";
import type { Conversation, ConversationPatch } from "../types/conversation.js";
import type {
  ConversationMessage,
  MessagePayload,
  PresentedMessage,
  SealedEnvelope,
  StoredFlag,
  StoredMessage,
} from "../types/message.js";


/** A peer as the relay publishes it, before it is verified and cached. */
export interface PeerProfile {
  id: string;
  username: string;
  level?: number;
  level_name?: string;
  identity_pk: string;
  kex_pk: string;
  kex_key_signature: string;
}

/** A message on its way into storage. `pending`/`seen` are still booleans here. */
interface IncomingMessage {
  id: string;
  conversationId: string;
  senderId: string;
  createdAt: number;
  envelope: SealedEnvelope;
  pending?: boolean;
  seen?: boolean | StoredFlag;
  deliveredAck?: boolean | StoredFlag;
  readAck?: boolean | StoredFlag;
  deliveredAt?: number | null;
  readAt?: number | null;
}

/** The two receipt columns a sweep can stamp. */
type ReceiptField = "deliveredAt" | "readAt";
type AckField = "deliveredAck" | "readAck";

const NONCE_BYTES = 24;
const MAX_CALL_SIGNAL_CIPHERTEXT_BYTES = 48 * 1024;

/** Seal an arbitrary value under the device key, for metadata at rest. */
function sealLocal(value: unknown): SealedLocal {
  const { localDbKey } = currentIdentity();
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(localDbKey, nonce).encrypt(
    utf8ToBytes(JSON.stringify(value)),
  );
  return { n: bytesToBase64(nonce), c: bytesToBase64(ciphertext) };
}

/**
 * Unseal a local record. Generic because the caller is the only thing that
 * knows what it put in -- the ciphertext carries no shape of its own.
 */
function openLocal<T>(sealed: SealedLocal | null | undefined): T | null {
  if (!sealed) return null;
  const { localDbKey } = currentIdentity();
  const plaintext = xchacha20poly1305(localDbKey, base64ToBytes(sealed.n)).decrypt(
    base64ToBytes(sealed.c),
  );
  return JSON.parse(bytesToUtf8(plaintext)) as T;
}

// --- peers -----------------------------------------------------------------

export class PeerKeyVerificationError extends Error {
  readonly retainExisting: boolean;

  constructor(
    message = "This contact's identity key could not be verified. Messaging is blocked to protect your conversation.",
    retainExisting = false,
  ) {
    super(message);
    this.name = "PeerKeyVerificationError";
    this.retainExisting = retainExisting;
  }
}

/** Cache a peer's profile and public keys so chats render while offline. */
export async function putPeer(peer: PeerProfile): Promise<void> {
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
    const trusted = openLocal<PeerProfile>(existing.data);
    if (trusted && (trusted.identity_pk !== peer.identity_pk || trusted.kex_pk !== peer.kex_pk)) {
      throw new PeerKeyVerificationError(
        "This contact's identity key changed unexpectedly. Compare safety numbers before messaging again.",
        true,
      );
    }
  }
  await db.put(STORE_PEERS, { id: peer.id, data: sealLocal(peer) });
}

export async function getPeer(userId: string): Promise<PeerProfile | null> {
  const db = await timberDb();
  const record = await db.get(STORE_PEERS, userId);
  return record ? openLocal<PeerProfile>(record.data) : null;
}

/** Remove any stale or untrusted peer key before it can be used for ECDH. */
export async function deletePeer(userId: string): Promise<void> {
  const db = await timberDb();
  await db.delete(STORE_PEERS, userId);
}

export async function allPeers(): Promise<PeerProfile[]> {
  const db = await timberDb();
  return (await db.getAll(STORE_PEERS))
    .map((record) => openLocal<PeerProfile>(record.data))
    .filter((peer): peer is PeerProfile => peer !== null);
}

// --- conversations ---------------------------------------------------------

export async function upsertConversation(conversation: ConversationPatch): Promise<ConversationPatch> {
  const db = await timberDb();
  const existing = await db.get(STORE_CONVERSATIONS, conversation.id);
  const merged: ConversationPatch = {
    ...(existing ? openLocal<ConversationPatch>(existing.data) : null),
    ...conversation,
  };
  await db.put(STORE_CONVERSATIONS, {
    id: conversation.id,
    updatedAt: conversation.updatedAt ?? existing?.updatedAt ?? 0,
    data: sealLocal(merged),
  });
  return merged;
}

export async function getConversation(conversationId: string): Promise<Conversation | null> {
  const db = await timberDb();
  const record = await db.get(STORE_CONVERSATIONS, conversationId);
  return record ? openLocal<Conversation>(record.data) : null;
}

/** Conversations most-recently-active first, the order the Chats tab renders. */
export async function listConversations(): Promise<Conversation[]> {
  const db = await timberDb();
  const records = await db.getAll(STORE_CONVERSATIONS);
  return records
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map((record) => openLocal<Conversation>(record.data))
    .filter((conversation): conversation is Conversation => conversation !== null);
}

export async function touchConversation(conversationId: string, updatedAt: number): Promise<void> {
  const db = await timberDb();
  const record = await db.get(STORE_CONVERSATIONS, conversationId);
  if (record && (record.updatedAt ?? 0) < updatedAt) {
    await db.put(STORE_CONVERSATIONS, { ...record, updatedAt });
  }
}

/** Remove a conversation and its local ciphertext when the friendship is removed. */
export async function deleteConversation(conversationId: string, peerId: string | null = null): Promise<void> {
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
export async function keyForConversation(conversationId: string): Promise<Uint8Array | null> {
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
export async function sealCallSignal(conversationId: string, payload: MessagePayload): Promise<SealedEnvelope> {
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
export async function openCallSignal(
  conversationId: string,
  senderId: string,
  envelope: SealedEnvelope,
): Promise<MessagePayload> {
  const key = await keyForConversation(conversationId);
  if (!key) throw new Error("This conversation is not ready for a secure call.");
  return openEnvelope({ key, conversationId, senderId, envelope });
}

// --- messages --------------------------------------------------------------

/** IndexedDB indexes cannot key on booleans, so flags are stored as 0/1. */
const flag = (value: unknown): StoredFlag => (value ? 1 : 0);

/**
 * Receipts that arrived before their message was stored, keyed by message id.
 * Drained by `putMessage`. Bounded by the fact that every entry is for a message
 * the relay has already echoed, so one is always on its way.
 */
const deferredReceipts = new Map<string, Partial<Record<ReceiptField, number>>>();

/**
 * Persist a sealed message.
 *
 * `pending` marks a message written optimistically that the server has not yet
 * acknowledged; the outbox retries these on reconnect. IndexedDB indexes cannot
 * key on booleans, so it is stored as 0/1.
 */
export async function putMessage(message: IncomingMessage): Promise<StoredMessage> {
  const db = await timberDb();
  const existing = await db.get(STORE_MESSAGES, message.id);
  const record: StoredMessage = {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    createdAt: message.createdAt,
    pending: message.pending ? 1 : 0,
    // `seen` is the unread badge. The two `*Ack` flags are whether we have
    // successfully told the sender. Keeping them apart is what makes a lost
    // receipt retryable instead of permanent.
    seen: flag(message.seen ?? existing?.seen),
    deliveredAck: flag(message.deliveredAck ?? existing?.deliveredAck),
    readAck: flag(message.readAck ?? existing?.readAck),
    // Receipts only ever move forward. Re-storing a message during a backfill
    // must not walk three ticks back to one because this page of history was
    // fetched before the peer opened it.
    deliveredAt: message.deliveredAt ?? existing?.deliveredAt ?? null,
    readAt: message.readAt ?? existing?.readAt ?? null,
    envelope: message.envelope,
  };

  // A receipt can arrive before the message it describes: the peer acknowledges
  // the moment the relay echoes it, which can beat our own optimistic row being
  // swapped for its real id. Apply anything parked for this id now.
  const deferred = deferredReceipts.get(message.id);
  if (deferred) {
    deferredReceipts.delete(message.id);
    for (const field of ["deliveredAt", "readAt"] as const) {
      const at = deferred[field];
      if (at !== undefined && !record[field]) record[field] = at;
    }
    if (record.readAt && !record.deliveredAt) record.deliveredAt = record.readAt;
  }

  await db.put(STORE_MESSAGES, record);
  await touchConversation(message.conversationId, message.createdAt);
  return record;
}

/** Replace an optimistic message once the server assigns its real id. */
export async function confirmMessage(temporaryId: string, confirmed: IncomingMessage): Promise<StoredMessage> {
  const db = await timberDb();
  await db.delete(STORE_MESSAGES, temporaryId);
  return putMessage({ ...confirmed, pending: false });
}

export async function getMessage(messageId: string): Promise<StoredMessage | undefined> {
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
export async function messagesFor(
  conversationId: string,
  { before = null, limit = 50 }: { before?: number | null; limit?: number } = {},
): Promise<ConversationMessage[]> {
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
export function presentMessages(messages: ConversationMessage[], now: number = Date.now()): ConversationMessage[] {
  const visible = new Map<string, ConversationMessage>();
  const order: string[] = [];

  /** The message a control payload refers to, if it is still visible. */
  const targetOf = (id: string): PresentedMessage | null => {
    const original = visible.get(id);
    return original && !original.undecryptable ? original : null;
  };

  for (const message of messages) {
    if (message.undecryptable) {
      visible.set(message.id, message);
      order.push(message.id);
      continue;
    }
    const payload = message.payload;

    if (payload.t === "reaction") {
      const original = targetOf(payload.message_id);
      if (original) {
        const reactions = { ...original.reactions };
        const people = new Set(reactions[payload.emoji] ?? []);
        if (payload.remove) people.delete(message.senderId);
        else people.add(message.senderId);
        // An emoji nobody holds any more must disappear rather than linger as
        // an empty chip with a count of zero.
        if (people.size) reactions[payload.emoji] = [...people];
        else delete reactions[payload.emoji];
        original.reactions = reactions;
      }
      continue;
    }

    if (payload.t === "edit" || payload.t === "delete" || payload.t === "pin") {
      const original = targetOf(payload.message_id);
      if (original) {
        // Only an author can alter or retract their own message. Pins are a
        // mutual conversation feature, so either participant may add/remove one.
        const byAuthor = original.senderId === message.senderId;
        if (payload.t === "edit" && byAuthor && original.payload.t === "text") {
          original.payload = { ...original.payload, body: payload.body, edited: true };
        }
        if (payload.t === "delete" && byAuthor) {
          original.deleted = true;
          // Blanking the body is not cosmetic: the chat-list preview reads it,
          // so leaving it would show retracted text in the list forever.
          original.payload = blankBody(original.payload);
        }
        if (payload.t === "pin") original.pinned = payload.pinned;
      }
      continue;
    }

    if (payload.t === "decision_vote") {
      const original = targetOf(payload.decision_id);
      if (original?.payload.t === "decision") {
        original.votes = { ...original.votes, [message.senderId]: payload.value };
      }
      continue;
    }

    if (payload.t === "call_update") {
      const card = [...visible.values()].find((entry): entry is PresentedMessage => (
        !entry.undecryptable
        && entry.payload.t === "call"
        && entry.payload.call_id === payload.call_id
      ));
      // A call card has one author: the person who placed the call. The peer can
      // signal its outcome, but cannot forge or rewrite the encrypted history.
      if (card && card.senderId === message.senderId && card.payload.t === "call") {
        card.payload = {
          ...card.payload,
          status: payload.status,
          ...(payload.duration_ms !== undefined && Number.isFinite(payload.duration_ms)
            ? { duration_ms: payload.duration_ms }
            : {}),
        };
      }
      continue;
    }

    const entry: PresentedMessage = { ...message, payload: { ...payload } };
    const expiresAt = "expires_at" in payload ? payload.expires_at : undefined;
    if (expiresAt && new Date(expiresAt).getTime() <= now) {
      entry.expired = true;
      entry.payload = blankBody(entry.payload);
    }
    visible.set(message.id, entry);
    order.push(message.id);
  }

  return order
    .map((id) => visible.get(id))
    .filter((message): message is ConversationMessage => message !== undefined);
}

/**
 * Clear the readable text of a payload that has any, leaving other payload
 * kinds untouched. Used for retraction and expiry, both of which must stop the
 * text reaching the chat-list preview as well as the thread.
 */
function blankBody(payload: MessagePayload): MessagePayload {
  return "body" in payload ? { ...payload, body: "" } : payload;
}

function decryptRecord(record: StoredMessage, conversationId: string, key: Uint8Array | null): ConversationMessage {
  const base = {
    id: record.id,
    conversationId: record.conversationId,
    senderId: record.senderId,
    createdAt: record.createdAt,
    deliveredAt: record.deliveredAt ?? null,
    readAt: record.readAt ?? null,
    pending: record.pending === 1,
    seen: record.seen === 1,
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
export async function lastMessage(conversationId: string): Promise<ConversationMessage | null> {
  const [message] = await messagesFor(conversationId, { limit: 1 });
  return message ?? null;
}

/** Seal and store a message this device is sending. */
export async function composeMessage({ conversationId, payload, id, createdAt = Date.now() }: {
  conversationId: string;
  payload: MessagePayload;
  id: string;
  createdAt?: number;
}): Promise<SealedEnvelope> {
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
    envelope,
  });
  return envelope;
}

export async function unreadCount(conversationId: string): Promise<number> {
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
    if (cursor.value.seen === 0 && cursor.value.senderId !== identity.userId) count += 1;
    cursor = await cursor.continue();
  }
  return count;
}

/**
 * Mark the peer's messages in a conversation as seen, clearing the badge.
 *
 * Deliberately does not touch `readAck`: telling the sender is a separate step
 * that can fail, and conflating the two is what made a dropped read receipt
 * unrecoverable.
 */
export async function markSeen(conversationId: string, selfId: string): Promise<string[]> {
  const db = await timberDb();
  const tx = db.transaction(STORE_MESSAGES, "readwrite");
  const range = IDBKeyRange.bound(
    [conversationId, Number.MIN_SAFE_INTEGER],
    [conversationId, Number.MAX_SAFE_INTEGER],
  );
  const marked = [];
  let cursor = await tx.store.index("byConversation").openCursor(range);
  while (cursor) {
    if (cursor.value.seen === 0 && cursor.value.senderId !== selfId) {
      marked.push(cursor.value.id);
      await cursor.update({ ...cursor.value, seen: 1 });
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return marked;
}

/**
 * Stamp a receipt on messages this device sent.
 *
 * `field` is `deliveredAt` or `readAt`. Read implies delivery, so marking a
 * message read backfills delivery too: a receipt pair that arrived out of
 * order must never leave a message showing three ticks with no second state.
 */
export async function markReceipt(
  messageIds: Iterable<string>,
  field: ReceiptField,
  at: number = Date.now(),
): Promise<string[]> {
  const db = await timberDb();
  const tx = db.transaction(STORE_MESSAGES, "readwrite");
  const changed: string[] = [];
  for (const id of messageIds) {
    const record = await tx.store.get(id);
    if (!record) {
      // The message is not here yet -- park it for `putMessage` to apply.
      deferredReceipts.set(id, { ...(deferredReceipts.get(id) ?? {}), [field]: at });
      continue;
    }
    if (record[field]) continue;
    const next = { ...record, [field]: at };
    if (field === "readAt" && !next.deliveredAt) next.deliveredAt = at;
    await tx.store.put(next);
    changed.push(id);
  }
  await tx.done;
  return changed;
}

/**
 * Peer messages this device holds whose sender has not been told yet.
 *
 * `field` is `deliveredAck` ("we have it") or `readAck` ("it was opened").
 * Sweeping is what turns the sender's ticks: the backlog case that matters is a
 * device that was offline, where messages were stored by a backfill and there
 * was never a moment to acknowledge them one at a time.
 */
async function unsentReceiptIds(
  conversationId: string,
  selfId: string,
  field: AckField,
  extra: ((record: StoredMessage) => boolean) | null,
  limit: number,
): Promise<string[]> {
  const db = await timberDb();
  const range = IDBKeyRange.bound(
    [conversationId, Number.MIN_SAFE_INTEGER],
    [conversationId, Number.MAX_SAFE_INTEGER],
  );
  const ids: string[] = [];
  let cursor = await db.transaction(STORE_MESSAGES).store.index("byConversation").openCursor(range);
  while (cursor && ids.length < limit) {
    const record = cursor.value;
    if (
      record.senderId !== selfId
      && record.pending === 0
      && !record[field]
      && (!extra || extra(record))
    ) {
      ids.push(record.id);
    }
    cursor = await cursor.continue();
  }
  return ids;
}

/** Messages we hold but have not confirmed delivery of. */
export function unacknowledgedMessageIds(conversationId: string, selfId: string, limit = 500): Promise<string[]> {
  return unsentReceiptIds(conversationId, selfId, "deliveredAck", null, limit);
}

/** Messages the user has opened but whose sender has not been told. */
export function unreadAckedMessageIds(conversationId: string, selfId: string, limit = 500): Promise<string[]> {
  return unsentReceiptIds(conversationId, selfId, "readAck", (record) => record.seen === 1, limit);
}

async function markAck(messageIds: string[], field: AckField): Promise<void> {
  if (!messageIds.length) return;
  const db = await timberDb();
  const tx = db.transaction(STORE_MESSAGES, "readwrite");
  for (const id of messageIds) {
    const record = await tx.store.get(id);
    if (record && !record[field]) await tx.store.put({ ...record, [field]: 1 });
  }
  await tx.done;
}

/** Remember that the relay took our delivery receipt, so we stop resending. */
export const markDeliveredAck = (messageIds: string[]) => markAck(messageIds, "deliveredAck");

/** Remember that the relay took our read receipt. */
export const markReadAck = (messageIds: string[]) => markAck(messageIds, "readAck");

/** Messages awaiting delivery, oldest first, for the reconnect outbox. */
export async function pendingMessages(): Promise<StoredMessage[]> {
  const db = await timberDb();
  const records = await db.getAllFromIndex(STORE_MESSAGES, "byPending", 1);
  return records.sort((a, b) => a.createdAt - b.createdAt);
}

const SAVED_MESSAGES_META_KEY = "saved-messages";

/** One entry in the device-local saved-message list. */
interface SavedEntry {
  id: string;
  conversationId: string;
}

/** Saved messages are an encrypted, device-local list, never a server feature. */
export async function toggleSavedMessage(message: { id: string; conversationId: string }): Promise<boolean> {
  const saved = (await getMeta<SavedEntry[]>(SAVED_MESSAGES_META_KEY)) ?? [];
  const exists = saved.some((entry) => entry.id === message.id);
  const next = exists
    ? saved.filter((entry) => entry.id !== message.id)
    : [...saved, { id: message.id, conversationId: message.conversationId }];
  await setMeta(SAVED_MESSAGES_META_KEY, next);
  return !exists;
}

export async function savedMessageIds(): Promise<Set<string>> {
  const saved = (await getMeta<SavedEntry[]>(SAVED_MESSAGES_META_KEY)) ?? [];
  return new Set(saved.map((entry) => entry.id));
}

/** Read the encrypted device-local saved-message collection on demand. */
export async function savedMessages(): Promise<ConversationMessage[]> {
  const entries = (await getMeta<SavedEntry[]>(SAVED_MESSAGES_META_KEY)) ?? [];
  const results: ConversationMessage[] = [];
  for (const entry of entries) {
    const record = await getMessage(entry.id);
    if (!record || record.conversationId !== entry.conversationId) continue;
    results.push(decryptRecord(record, entry.conversationId, await keyForConversation(entry.conversationId)));
  }
  return results.filter((message) => !message.undecryptable).sort((a, b) => b.createdAt - a.createdAt);
}

function searchableText(payload: MessagePayload | undefined): string {
  if (!payload) return "";
  // Read positionally rather than by narrowing on `t`: search deliberately
  // spans every payload kind, and a new one should become searchable by
  // carrying a known field, not by being added to a list here.
  const fields = payload as Partial<Record<"body" | "name" | "mime" | "prompt" | "kind", unknown>>;
  const values: string[] = [];
  for (const key of ["body", "name", "mime", "prompt", "kind"] as const) {
    const value = fields[key];
    if (typeof value === "string") values.push(value);
  }
  const options = (payload as { options?: unknown }).options;
  if (Array.isArray(options)) {
    values.push(...options.filter((value): value is string => typeof value === "string"));
  }
  return values.join(" ").toLowerCase();
}

/**
 * Private, on-device full-text search. It deliberately scans encrypted rows at
 * query time instead of writing a plaintext index into IndexedDB.
 */
export async function searchMessages(
  query: string,
  { limit = 100 }: { limit?: number } = {},
): Promise<ConversationMessage[]> {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  const db = await timberDb();
  const records = await db.getAll(STORE_MESSAGES);
  const keys = new Map<string, Uint8Array | null>();
  const matches: ConversationMessage[] = [];
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

export async function getMeta<T = unknown>(key: string): Promise<T | null> {
  const db = await timberDb();
  const record = await db.get(STORE_META, key);
  return record ? openLocal(record) : null;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await timberDb();
  await db.put(STORE_META, sealLocal(value), key);
}
