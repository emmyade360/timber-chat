// The v1 -> v2 upgrade.
//
// v1 stored one `read` flag doing two jobs: "the user saw it" and "we told the
// sender". This upgrade splits them, and deliberately resets every read
// acknowledgement so the first sweep afterwards re-sends receipts that v1 lost
// — that is what heals conversations already stuck on two ticks.

import { beforeEach, describe, expect, it } from "vitest";
import { openDB, deleteDB } from "idb";
import { DB_NAME, STORE_MESSAGES, destroyTimberDb, timberDb } from "./timberDb.js";

/** Build a v1 database with the old record shape. */
async function seedV1(records) {
  const db = await openDB(DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore("vault");
      database.createObjectStore("meta");
      database.createObjectStore("conversations", { keyPath: "id" });
      const messages = database.createObjectStore(STORE_MESSAGES, { keyPath: "id" });
      messages.createIndex("byConversation", ["conversationId", "createdAt"]);
      messages.createIndex("byPending", "pending");
      database.createObjectStore("peers", { keyPath: "id" });
    },
  });
  const tx = db.transaction(STORE_MESSAGES, "readwrite");
  for (const record of records) await tx.store.put(record);
  await tx.done;
  db.close();
}

const v1Record = (id, overrides = {}) => ({
  id,
  conversationId: "c1",
  senderId: "peer",
  createdAt: 1000,
  pending: 0,
  read: 0,
  envelope: { envelope_version: 1, nonce: "", ciphertext: "" },
  ...overrides,
});

beforeEach(async () => {
  await destroyTimberDb();
  await deleteDB(DB_NAME);
});

describe("v1 to v2 upgrade", () => {
  it("moves read into seen and keeps the delivery acknowledgement", async () => {
    await seedV1([
      v1Record("unseen", { read: 0 }),
      v1Record("seen", { read: 1, acknowledged: 1 }),
    ]);

    const db = await timberDb();
    const unseen = await db.get(STORE_MESSAGES, "unseen");
    const seen = await db.get(STORE_MESSAGES, "seen");

    expect(unseen.seen).toBe(0);
    expect(seen.seen).toBe(1);
    expect(seen.deliveredAck).toBe(1);
    expect(unseen.deliveredAck).toBe(0);
  });

  it("resets every read acknowledgement so lost receipts are re-sent", async () => {
    // This is the healing step: under v1 this message was read but its receipt
    // was never delivered, and there was no way to know or retry. After the
    // upgrade it is queued again.
    await seedV1([v1Record("stuck", { read: 1, acknowledged: 1 })]);

    const db = await timberDb();
    const stuck = await db.get(STORE_MESSAGES, "stuck");

    expect(stuck.seen).toBe(1);
    expect(stuck.readAck).toBe(0);
  });

  it("drops the old field names entirely", async () => {
    await seedV1([v1Record("one", { read: 1, acknowledged: 1 })]);
    const db = await timberDb();
    const record = await db.get(STORE_MESSAGES, "one");
    expect(record).not.toHaveProperty("read");
    expect(record).not.toHaveProperty("acknowledged");
  });

  it("leaves receipts about our own outgoing messages untouched", async () => {
    await seedV1([v1Record("mine", { senderId: "me", deliveredAt: 111, readAt: 222 })]);
    const db = await timberDb();
    const record = await db.get(STORE_MESSAGES, "mine");
    expect(record.deliveredAt).toBe(111);
    expect(record.readAt).toBe(222);
  });
});
