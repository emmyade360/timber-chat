// Message sealing. The server stores only what leaves this file, and it holds no
// key capable of opening any of it.
//
// Conversation key = HKDF(X25519(my kex secret, peer kex public), info=sorted user ids).
// Both participants derive the identical key offline; it is never transmitted.
//
// Each message is sealed with XChaCha20-Poly1305 under a fresh 24-byte random nonce.
// The conversation id and sender id are bound in as additional authenticated data, so
// a stored ciphertext cannot be replayed into a different conversation or re-attributed
// to a different sender by anyone -- including the server.

import { x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  concatBytes,
  randomBytes,
  utf8ToBytes,
} from "./bytes.js";
import type {
  CallMode,
  CallPayload,
  CallStatus,
  CallUpdatePayload,
  DecisionPayload,
  DecisionVotePayload,
  DeletePayload,
  EditPayload,
  EnvelopeVersion,
  FilePayload,
  MessagePayload,
  PinPayload,
  PostcardPayload,
  ReactionPayload,
  ReadableEnvelope,
  SealedEnvelope,
  TextPayload,
} from "../types/message.js";

/** A key given either as raw bytes or as the base64 the wire uses. */
type KeyInput = Uint8Array | string;

export type { ReadableEnvelope, SealedEnvelope } from "../types/message.js";

/** Envelope format version. Bump when the wire format changes; readers switch on it. */
export const ENVELOPE_VERSION: EnvelopeVersion = 2;
export const SUPPORTED_ENVELOPE_VERSIONS = new Set([1, ENVELOPE_VERSION]);

const NONCE_BYTES = 24;
const APP_SALT = utf8ToBytes("timber/hkdf/v1");

/** Server-side cap on a stored envelope; keep the client below it. */
export const MAX_CIPHERTEXT_BYTES = 8192;

const conversationKeys = new Map<string, Uint8Array>();

function conversationInfo(userIdA: string, userIdB: string): Uint8Array {
  // Both devices must derive from the same ordering or the keys diverge.
  const ascending = userIdA <= userIdB;
  const first = ascending ? userIdA : userIdB;
  const second = ascending ? userIdB : userIdA;
  return utf8ToBytes(`timber/dm/v1:${first}:${second}`);
}

/**
 * Derive (and cache) the symmetric key for a conversation.
 *
 * Cached by conversation id because the X25519 scalar multiplication is the most
 * expensive step in rendering a chat, and a list view decrypts every preview.
 */
export function conversationKey({ conversationId, kexSk, peerKexPk, userId, peerUserId }: {
  conversationId: string;
  kexSk: Uint8Array;
  peerKexPk: KeyInput;
  userId: string;
  peerUserId: string;
}): Uint8Array {
  // Keyed by owner as well as conversation: two identities in one process (tests,
  // and any future multi-account support) must never collide on a cache entry.
  const cacheKey = `${userId}:${conversationId}`;
  const cached = conversationKeys.get(cacheKey);
  if (cached) return cached;

  const peer = typeof peerKexPk === "string" ? base64ToBytes(peerKexPk) : peerKexPk;
  const shared = x25519.getSharedSecret(kexSk, peer);
  const key = hkdf(sha256, shared, APP_SALT, conversationInfo(userId, peerUserId), 32);
  shared.fill(0);

  conversationKeys.set(cacheKey, key);
  return key;
}

/** Drop cached keys. Call on lock/sign-out so nothing survives in memory. */
export function forgetConversationKeys(): void {
  for (const key of conversationKeys.values()) key.fill(0);
  conversationKeys.clear();
}

function aad(version: number, conversationId: string, senderId: string): Uint8Array {
  return utf8ToBytes(`${version}:${conversationId}:${senderId}`);
}

/**
 * Seal a payload for storage and transport.
 *
 * @returns {{envelope_version:number, nonce:string, ciphertext:string}} base64 fields
 */
export function seal({ key, conversationId, senderId, payload, maxCiphertextBytes = MAX_CIPHERTEXT_BYTES }: {
  key: Uint8Array;
  conversationId: string;
  senderId: string;
  payload: MessagePayload;
  maxCiphertextBytes?: number;
}): SealedEnvelope {
  const nonce = randomBytes(NONCE_BYTES);
  const plaintext = utf8ToBytes(JSON.stringify(payload));
  const ciphertext = xchacha20poly1305(key, nonce, aad(ENVELOPE_VERSION, conversationId, senderId)).encrypt(plaintext);
  plaintext.fill(0);

  if (ciphertext.length > maxCiphertextBytes) {
    throw new Error("That message is too long to send.");
  }

  return {
    envelope_version: ENVELOPE_VERSION,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
  };
}

/**
 * Open a sealed envelope.
 *
 * Throws if the ciphertext, nonce, conversation, or sender has been altered by
 * anyone in transit or at rest. Callers render a "could not be decrypted" row
 * rather than dropping the message silently, so tampering stays visible.
 */
export function open({ key, conversationId, senderId, envelope }: {
  key: Uint8Array;
  conversationId: string;
  senderId: string;
  envelope: ReadableEnvelope;
}): MessagePayload {
  const version = "envelope_version" in envelope ? envelope.envelope_version : envelope.v;
  if (!SUPPORTED_ENVELOPE_VERSIONS.has(version)) {
    throw new Error(`Unsupported message format (v${version}).`);
  }
  const nonce = base64ToBytes(envelope.nonce);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const plaintext = xchacha20poly1305(key, nonce, aad(version, conversationId, senderId)).decrypt(ciphertext);
  // Poly1305 has already authenticated this against the conversation and sender,
  // so the bytes are ours. The JSON shape is still only as good as the sender's
  // version of this file, which is why readers switch on `t` rather than trust it.
  return JSON.parse(bytesToUtf8(plaintext)) as MessagePayload;
}

/** Payload constructors. Attachments travel inside the sealed body, never as columns. */
export const payloads = {
  text: (body: string, { replyTo = null, quiet = false }: { replyTo?: string | null; quiet?: boolean } = {}): TextPayload => ({
    v: ENVELOPE_VERSION, t: "text", body, ...(replyTo ? { reply_to: replyTo } : {}), ...(quiet ? { quiet: true } as const : {}),
  }),
  file: ({ attachmentId, key, name, mime, size, kind = "file", durationMs = null, expiresAt = null }: {
    attachmentId: string;
    key: string;
    name: string;
    mime: string;
    size: number;
    kind?: "file" | "voice";
    durationMs?: number | null;
    expiresAt?: number | null;
  }): FilePayload => ({
    v: ENVELOPE_VERSION,
    t: "file",
    attachment_id: attachmentId,
    key,
    name,
    mime,
    size,
    kind,
    ...(durationMs ? { duration_ms: durationMs } : {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  }),
  reaction: (messageId: string, emoji: string, { remove = false }: { remove?: boolean } = {}): ReactionPayload =>
    ({ v: ENVELOPE_VERSION, t: "reaction", message_id: messageId, emoji, ...(remove ? { remove: true } as const : {}) }),
  edit: (messageId: string, body: string): EditPayload =>
    ({ v: ENVELOPE_VERSION, t: "edit", message_id: messageId, body }),
  delete: (messageId: string): DeletePayload =>
    ({ v: ENVELOPE_VERSION, t: "delete", message_id: messageId }),
  pin: (messageId: string, pinned: boolean): PinPayload =>
    ({ v: ENVELOPE_VERSION, t: "pin", message_id: messageId, pinned }),
  decision: ({ kind = "poll", prompt, options = [], dueAt = null }: {
    kind?: "poll" | "decision";
    prompt: string;
    options?: string[];
    dueAt?: number | null;
  }): DecisionPayload => ({
    v: ENVELOPE_VERSION, t: "decision", kind, prompt, options, ...(dueAt ? { due_at: dueAt } : {}),
  }),
  decisionVote: (decisionId: string, value: string): DecisionVotePayload =>
    ({ v: ENVELOPE_VERSION, t: "decision_vote", decision_id: decisionId, value }),
  postcard: ({ body, expiresAt, kind = "text", replyTo = null }: {
    body: string;
    expiresAt: number;
    kind?: string;
    replyTo?: string | null;
  }): PostcardPayload => ({
    v: ENVELOPE_VERSION, t: "postcard", kind, body, expires_at: expiresAt, ...(replyTo ? { reply_to: replyTo } : {}),
  }),
  /**
   * The record a call leaves behind in the conversation.
   *
   * Only the caller writes it, and only the caller amends it, so the two devices
   * never race to describe the same call. Setup signals are separately sealed
   * and may be retained for at most 60 seconds to wake an installed recipient;
   * this card is an ordinary sealed message like any other.
   */
  call: ({ callId, mode, status = "calling" }: {
    callId: string;
    mode: CallMode;
    status?: CallStatus;
  }): CallPayload => ({
    v: ENVELOPE_VERSION, t: "call", call_id: callId, mode, status,
  }),
  callUpdate: (callId: string, { status, durationMs = null }: {
    status: CallStatus;
    durationMs?: number | null;
  }): CallUpdatePayload => ({
    v: ENVELOPE_VERSION,
    t: "call_update",
    call_id: callId,
    status,
    ...(durationMs ? { duration_ms: durationMs } : {}),
  }),
};

/**
 * Encrypt an attachment under its own single-use key before upload.
 *
 * The key is returned to the caller to be placed inside the sealed message payload,
 * so the storage bucket holds an opaque blob and the server never sees the key.
 * The nonce is prefixed to the blob because storage has nowhere else to put it.
 */
export function encryptFile(bytes: Uint8Array): { blob: Uint8Array; key: string } {
  const fileKey = randomBytes(32);
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(fileKey, nonce).encrypt(bytes);
  return {
    blob: concatBytes(nonce, ciphertext),
    key: bytesToBase64(fileKey),
  };
}

/** Reverse of encryptFile, for rendering a received attachment. */
export function decryptFile(blob: Uint8Array, keyBase64: string): Uint8Array {
  const fileKey = base64ToBytes(keyBase64);
  const nonce = blob.subarray(0, NONCE_BYTES);
  const ciphertext = blob.subarray(NONCE_BYTES);
  const plaintext = xchacha20poly1305(fileKey, nonce).decrypt(ciphertext);
  fileKey.fill(0);
  return plaintext;
}
