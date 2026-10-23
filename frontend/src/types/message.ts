// The shape of everything inside a sealed envelope.
//
// These mirror `payloads` in src/crypto/envelope.js exactly, including its
// snake_case wire names. They are the plaintext a device sees after `open()`
// and are never sent unencrypted -- the relay only ever holds the ciphertext.

/**
 * The sealed form: what the relay stores and all it ever sees. Base64 fields.
 */
export interface SealedEnvelope {
  envelope_version: number;
  nonce: string;
  ciphertext: string;
}

/** v1 envelopes carried the version as `v`; v2 renamed it. Readers accept both. */
export type ReadableEnvelope =
  | SealedEnvelope
  | { v: number; nonce: string; ciphertext: string };

/** Bumped in envelope.js; v1 envelopes are still accepted on read. */
export type EnvelopeVersion = 1 | 2;

export type CallMode = "audio" | "video";

export type CallStatus =
  | "calling"
  | "ringing"
  | "active"
  | "completed"
  | "declined"
  | "no_answer"
  | "unavailable"
  | "failed";

interface PayloadBase {
  v: EnvelopeVersion;
  reply_to?: string;
}

export interface TextPayload extends PayloadBase {
  t: "text";
  body: string;
  quiet?: true;
  /** Set locally by `presentMessages` when an edit has been folded in. */
  edited?: boolean;
}

export interface FilePayload extends PayloadBase {
  t: "file";
  attachment_id: string;
  /** Base64 symmetric key for this attachment only. Never reused. */
  key: string;
  name: string;
  mime: string;
  size: number;
  kind: "file" | "voice";
  duration_ms?: number;
  expires_at?: number;
}

export interface ReactionPayload extends PayloadBase {
  t: "reaction";
  message_id: string;
  emoji: string;
  /** Set when taking a reaction back. Absent means adding one. */
  remove?: boolean;
}

export interface EditPayload extends PayloadBase {
  t: "edit";
  message_id: string;
  body: string;
}

export interface DeletePayload extends PayloadBase {
  t: "delete";
  message_id: string;
}

export interface PinPayload extends PayloadBase {
  t: "pin";
  message_id: string;
  pinned: boolean;
}

export interface DecisionPayload extends PayloadBase {
  t: "decision";
  kind: "poll" | "decision";
  prompt: string;
  options: string[];
  due_at?: number;
}

export interface DecisionVotePayload extends PayloadBase {
  t: "decision_vote";
  decision_id: string;
  value: string;
}

export interface PostcardPayload extends PayloadBase {
  t: "postcard";
  kind: string;
  body: string;
  expires_at: number;
}

export interface CallPayload extends PayloadBase {
  t: "call";
  call_id: string;
  mode: CallMode;
  status: CallStatus;
}

export interface CallUpdatePayload extends PayloadBase {
  t: "call_update";
  call_id: string;
  status: CallStatus;
  duration_ms?: number;
}

/**
 * Every payload a conversation can carry, discriminated on `t`.
 *
 * Exhaustive switches over this are what stop a new payload type from silently
 * rendering as a blank bubble -- the current code falls through to
 * `payload?.body`, which is empty for every control type.
 */
export type MessagePayload =
  | TextPayload
  | FilePayload
  | ReactionPayload
  | EditPayload
  | DeletePayload
  | PinPayload
  | DecisionPayload
  | DecisionVotePayload
  | PostcardPayload
  | CallPayload
  | CallUpdatePayload;

/** Payloads that occupy a bubble. The rest mutate an existing message. */
export type RenderablePayload =
  | TextPayload
  | FilePayload
  | DecisionPayload
  | PostcardPayload
  | CallPayload;

/** Control payloads are applied to an earlier message by `presentMessages`. */
export type ControlPayload = Exclude<MessagePayload, RenderablePayload>;

// --- storage ---------------------------------------------------------------

/** IndexedDB cannot index booleans, so these are stored as 0/1. */
export type StoredFlag = 0 | 1;

/** A row in the `messages` object store. `envelope` stays sealed at rest. */
export interface StoredMessage {
  id: string;
  conversationId: string;
  senderId: string;
  createdAt: number;
  pending: StoredFlag;
  /** Drives the unread badge. */
  seen: StoredFlag;
  /** Whether the *sender* has been told; kept apart from `seen` so a lost
   *  receipt is retryable rather than permanently missed. */
  deliveredAck: StoredFlag;
  readAck: StoredFlag;
  deliveredAt: number | null;
  readAt: number | null;
  /** Stored exactly as it went over the wire; opening it needs the PIN. */
  envelope: SealedEnvelope;
}

// --- projection ------------------------------------------------------------

interface DecryptedBase {
  id: string;
  conversationId: string;
  senderId: string;
  createdAt: number;
  deliveredAt: number | null;
  readAt: number | null;
  pending: boolean;
  seen: boolean;
  /** Present only until the relay assigns the real id. */
  clientId?: string;
}

/** A message whose key is missing or whose tag did not verify. */
export interface UndecryptableMessage extends DecryptedBase {
  undecryptable: true;
  reason: "waiting-for-key" | "verification-failed";
  payload?: undefined;
}

/** A message that opened, after control payloads have been folded in. */
export interface PresentedMessage extends DecryptedBase {
  undecryptable?: false;
  payload: MessagePayload;
  /** emoji -> the user ids that reacted with it. */
  reactions?: Record<string, string[]>;
  /** voter user id -> chosen option. */
  votes?: Record<string, string>;
  pinned?: boolean;
  deleted?: boolean;
  expired?: boolean;
}

export type ConversationMessage = PresentedMessage | UndecryptableMessage;

/** Narrowing helper: `undecryptable` is optional on the happy path. */
export function isUndecryptable(message: ConversationMessage): message is UndecryptableMessage {
  return message.undecryptable === true;
}

/** The three states a sent message can be in, as one, two, or three ticks. */
export type ReceiptState = "pending" | "sent" | "delivered" | "read";

export function receiptState(message: ConversationMessage): ReceiptState {
  if (message.pending) return "pending";
  if (message.readAt) return "read";
  if (message.deliveredAt) return "delivered";
  return "sent";
}
