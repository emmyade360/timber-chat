// The single IndexedDB database backing the app. Both the PIN vault and the
// encrypted message store live here so there is one schema and one upgrade path.
//
// Only the vault store holds data that is meaningful before unlock, and that data
// is itself sealed under the PIN. Everything in `conversations`, `messages`, and
// `peers` is encrypted at rest under the seed-derived local database key; the plain
// fields are limited to the ids and timestamps the indexes need in order to query.

import { openDB, deleteDB } from "idb";

export const DB_NAME = "timber";
export const DB_VERSION = 1;

export const STORE_VAULT = "vault";
export const STORE_META = "meta";
export const STORE_CONVERSATIONS = "conversations";
export const STORE_MESSAGES = "messages";
export const STORE_PEERS = "peers";

let dbPromise = null;

export function timberDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
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
      },
      blocked() {
        console.warn("Timber database upgrade blocked by another open tab.");
      },
    });
  }
  return dbPromise;
}

/** Destroy every trace of the account on this device. */
export async function destroyTimberDb() {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  await deleteDB(DB_NAME);
}
