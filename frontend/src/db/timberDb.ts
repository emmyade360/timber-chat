// The single IndexedDB database backing the app. Both the PIN vault and the
// encrypted message store live here so there is one schema and one upgrade path.
//
// Only the vault store holds data that is meaningful before unlock, and that data
// is itself sealed under the PIN. Everything in `conversations`, `messages`, and
// `peers` is encrypted at rest under the seed-derived local database key; the plain
// fields are limited to the ids and timestamps the indexes need in order to query.

import { openDB, deleteDB } from "idb";
import type { IDBPDatabase } from "idb";
import type { TimberDb } from "../types/db.js";
import type { SealedEnvelope } from "../types/message.js";

export const DB_NAME = "timber";
// v2 split the message `read` flag into `seen` (the unread badge) and the two
// receipt-sent flags. See the upgrade below for why that mattered.
export const DB_VERSION = 2;

export const STORE_VAULT = "vault";
export const STORE_META = "meta";
export const STORE_CONVERSATIONS = "conversations";
export const STORE_MESSAGES = "messages";
export const STORE_PEERS = "peers";

/**
 * The v1 message row. `read` did two jobs at once -- "the user has seen this"
 * and "we have told the sender" -- which is why a read receipt that was never
 * delivered could never be retried. Kept only for the v1 -> v2 upgrade below.
 */
interface LegacyMessageRecord {
  id: string;
  conversationId: string;
  senderId: string;
  createdAt: number;
  pending: 0 | 1;
  read?: boolean | number;
  acknowledged?: boolean | number;
  deliveredAt: number | null;
  readAt: number | null;
  envelope: SealedEnvelope;
}

let dbPromise: Promise<IDBPDatabase<TimberDb>> | null = null;

/** Set when another tab is holding the old version open; see `blocked` below. */
let upgradeBlocked = false;

/** True while a second tab is preventing the schema upgrade from completing. */
export function isUpgradeBlocked(): boolean {
  return upgradeBlocked;
}

export function timberDb(): Promise<IDBPDatabase<TimberDb>> {
  if (!dbPromise) {
    dbPromise = openDB<TimberDb>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (!db.objectStoreNames.contains(STORE_VAULT)) {
          db.createObjectStore(STORE_VAULT);
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META);
        }
        if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
          db.createObjectStore(STORE_CONVERSATIONS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          const messages = db.createObjectStore(STORE_MESSAGES, { keyPath: "id" });
          // Clear index fields only: enough to page a conversation without
          // decrypting, never enough to learn what was said.
          messages.createIndex("byConversation", ["conversationId", "createdAt"]);
          messages.createIndex("byPending", "pending");
        }
        if (!db.objectStoreNames.contains(STORE_PEERS)) {
          db.createObjectStore(STORE_PEERS, { keyPath: "id" });
        }

        // v1 -> v2. `read` was doing two jobs at once: "the user has seen this"
        // and "we have successfully told the sender". Once the first was set the
        // second was unrecoverable, so a read receipt that was never delivered
        // could never be retried -- the cause of messages stuck on two ticks.
        if (oldVersion >= 1 && oldVersion < 2) {
          const messages = transaction.objectStore(STORE_MESSAGES);
          void messages.openCursor().then(function migrate(cursor): Promise<undefined> | undefined {
            if (!cursor) return undefined;
            // A v1 row, by definition not yet the v2 shape the schema declares.
            const { read, acknowledged, ...rest } = cursor.value as unknown as LegacyMessageRecord;
            // The request is queued against the upgrade transaction the moment
            // `update` is called, so it is ordered before the `continue` below
            // whether or not it is awaited. `void` states that rather than
            // implying the write is unimportant.
            void cursor.update({
              ...rest,
              seen: read ? 1 : 0,
              deliveredAck: acknowledged ? 1 : 0,
              // Deliberately 0 for everything, including messages already seen.
              // The first sweep after the upgrade re-emits their read receipts,
              // which heals conversations that are stuck on two ticks today.
              // Replay is safe: the server inserts ON CONFLICT DO NOTHING and
              // only notifies the sender when a row actually changed.
              readAck: 0,
            });
            return cursor.continue().then(migrate);
          });
        }
      },
      blocked() {
        // Another tab is still on the old schema, so this one will hang at the
        // splash forever unless we say so out loud.
        upgradeBlocked = true;
        console.warn("Timber database upgrade blocked by another open tab.");
      },
      blocking() {
        // We are the old tab holding someone else up. Close so they can proceed;
        // this tab reopens the database lazily on its next query.
        console.warn("Closing an outdated Timber database connection so another tab can upgrade.");
        dbPromise?.then((db) => { db.close(); }).catch(() => {});
        dbPromise = null;
      },
    });
  }
  return dbPromise;
}

/** Destroy every trace of the account on this device. */
export async function destroyTimberDb(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  await deleteDB(DB_NAME);
}
