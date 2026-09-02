import type { ConversationMessage } from "./message.js";

/**
 * A conversation as this device holds it, after `reconcileRealtime` has folded
 * the relay's copy into local storage. Peer fields are denormalised so the chat
 * list and header render without a second lookup.
 */
export interface Conversation {
  id: string;
  peerId: string;
  peerUsername: string;
  peerLevel: number;
  peerLevelName: string;
  createdAt: number;
  /** 0 when nothing has been said yet; drives list ordering. */
  updatedAt: number;
  /**
   * Set when the peer's published keys stopped matching the copy this device
   * pinned. Non-null means the conversation is shown but not writable.
   */
  securityError: string | null;
  /** An unsent composer draft, sealed with the rest of the record. */
  draft?: string;
}

/**
 * `upsertConversation` merges a patch over whatever is already stored, so a
 * caller may send as little as an id. The merged result is only guaranteed to
 * be a full `Conversation` once a complete record has been written by sync.
 */
export type ConversationPatch = Partial<Conversation> & { id: string };

/** A conversation plus the newest message, for the chat list. */
export interface ConversationSummary extends Conversation {
  preview: ConversationMessage | null;
}

export type TypingMap = Record<string, string>;
export type UnreadMap = Record<string, number>;
export type MessageMap = Record<string, ConversationMessage[]>;
