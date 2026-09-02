// The IndexedDB schema, as one typed contract.
//
// Only the ids and timestamps the indexes need are stored in the clear.
// Everything else in `conversations`, `messages`, `peers` and `meta` is sealed
// under the seed-derived local database key -- which is why every value type
// below bottoms out in an opaque base64 `data` or `envelope` string rather than
// in readable fields.

import type { DBSchema } from "idb";
import type { StoredMessage } from "./message.js";

/**
 * Anything sealed under the seed-derived local database key: `n` is the base64
 * nonce, `c` the base64 ciphertext. Peer names, conversation metadata, drafts
 * and cursors all sit behind this, which is why no readable field appears on
 * the records below beyond the ids and timestamps the indexes need.
 */
export interface SealedLocal {
  n: string;
  c: string;
}

/**
 * The scrypt cost a PIN vault was written with.
 *
 * Stored per record rather than read from a module constant, because the
 * constant is the one thing that can never change safely: lowering it would
 * make every vault already on a device derive a different wrapping key and
 * become permanently unopenable. Recording the cost lets the parameters be
 * tuned for new vaults while old ones keep unlocking with the cost they were
 * sealed under.
 */
export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

/**
 * Who this device belongs to, in the clear.
 *
 * Deliberately outside the sealed blob: the lock screen has to greet someone
 * before it has any key to decrypt with. The trade is real and is stated in
 * the settings copy -- anyone holding the device learns which account it is
 * without knowing the PIN, which is why `forgetVaultIdentity` exists.
 */
export interface VaultIdentity {
  userId: string;
  username: string;
  avatarUrl?: string | null;
  level?: number | null;
  levelName?: string | null;
}

/** The PIN-wrapped recovery phrase. Meaningful before unlock; sealed regardless. */
export interface VaultRecord {
  salt: string;
  nonce: string;
  ciphertext: string;
  /** Counts toward MAX_ATTEMPTS; reset to 0 on a successful unlock. */
  attempts: number;
  version: number;
  createdAt: number;
  /** Absent on records written before the cost was recorded; see LEGACY_SCRYPT. */
  kdf?: ScryptCost;
  identity?: VaultIdentity;
  /**
   * Opt-in erase-after-MAX_ATTEMPTS, off unless the owner asks for it. The
   * phrase now resets a forgotten PIN without destroying anything, so wiping
   * on failed attempts costs real users their history to stop an attacker who
   * -- as crypto/vault.ts has always said -- can copy the blob and brute force
   * it offline regardless.
   */
  eraseOnFailure?: boolean;
}

/**
 * The unsecured vault: an account with no PIN yet.
 *
 * The phrase is sealed under an AES-GCM key generated as non-extractable, the
 * same device-bound trick crypto/resume.ts uses: the browser will decrypt with
 * it but will not hand its bytes back to script, so the phrase is never at rest
 * in the clear. The honest limit is identical -- anything running in this origin
 * can still ask the browser to decrypt -- which is exactly why setting a PIN is
 * offered, and why it is required before the phrase can be shown.
 */
export interface DeviceVaultRecord {
  kind: "device";
  key: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  sealed: ArrayBuffer;
  version: number;
  createdAt: number;
  identity?: VaultIdentity;
}

/** A resume token. The CryptoKey is non-extractable; see crypto/resume.ts. */
export interface ResumeRecord {
  key: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  sealed: ArrayBuffer;
  openedAt: number;
}

/** Everything the vault store can hold, under any of its fixed keys. */
export type StoredVaultRecord = VaultRecord | ResumeRecord | DeviceVaultRecord;

/**
 * The vault store keeps three unrelated shapes under two fixed keys. Reading one
 * where another was expected is a real hazard -- an unrecognised record must
 * be treated as "nothing to resume from", not coerced.
 *
 * `kind` discriminates the device vault explicitly rather than by field
 * presence, because it shares `key`/`iv`/`sealed` with a resume token and the
 * two must never be mistaken for one another.
 */
export function isDeviceVaultRecord(
  record: StoredVaultRecord | undefined,
): record is DeviceVaultRecord {
  return record !== undefined && "kind" in record && record.kind === "device";
}

export function isVaultRecord(
  record: StoredVaultRecord | undefined,
): record is VaultRecord {
  return record !== undefined && "ciphertext" in record && "salt" in record;
}

export function isResumeRecord(
  record: StoredVaultRecord | undefined,
): record is ResumeRecord {
  return record !== undefined
    && !isDeviceVaultRecord(record)
    && "key" in record
    && "sealed" in record;
}

export interface ConversationRecord {
  id: string;
  /** In the clear so the chat list can order without decrypting every row. */
  updatedAt: number;
  data: SealedLocal;
}

export interface PeerRecord {
  id: string;
  data: SealedLocal;
}

export interface TimberDb extends DBSchema {
  vault: {
    // Out-of-line keys: "seed" holds the vault, "resume" the session token.
    key: string;
    value: StoredVaultRecord;
  };
  meta: {
    key: string;
    /** Sealed opaquely; callers know what they put in. */
    value: SealedLocal;
  };
  conversations: {
    key: string;
    value: ConversationRecord;
  };
  messages: {
    key: string;
    value: StoredMessage;
    indexes: {
      /** Pages one conversation without decrypting anything. */
      byConversation: [string, number];
      /** The outbox. Booleans cannot be indexed, hence 0/1. */
      byPending: number;
    };
  };
  peers: {
    key: string;
    value: PeerRecord;
  };
}
