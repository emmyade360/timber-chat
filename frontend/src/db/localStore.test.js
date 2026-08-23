import { beforeEach, describe, expect, it } from "vitest";
import { createMnemonic, signKexKeyBinding } from "../crypto/identity.js";
import { closeSession, openSession } from "../crypto/session.js";
import { payloads } from "../crypto/envelope.js";
import { destroyTimberDb, STORE_MESSAGES, STORE_PEERS, timberDb } from "./timberDb.js";
import {
  composeMessage,
  confirmMessage,
  deleteConversation,
  getConversation,
  getPeer,
  keyForConversation,
  lastMessage,
  listConversations,
  markRead,
  messagesFor,
  pendingMessages,
  PeerKeyVerificationError,
  presentMessages,
  putMessage,
  putPeer,
  searchMessages,
  setMeta,
  getMeta,
  unreadCount,
  upsertConversation,
} from "./localStore.js";
import { seal } from "../crypto/envelope.js";
import { base64ToBytes, bytesToBase64 } from "../crypto/bytes.js";
import { deriveIdentity } from "../crypto/identity.js";

const CONVERSATION = "0f5f2b6a-1111-8222-8333-444455556666";

let me;
let peer;

/** Set up an unlocked session with one peer and one conversation on file. */
async function bootstrap() {
  await destroyTimberDb();
  closeSession();
  me = openSession(createMnemonic());
  peer = deriveIdentity(createMnemonic());
  await putPeer({
    id: peer.userId,
    username: "tobi",
    kex_pk: bytesToBase64(peer.kexPk),
    identity_pk: bytesToBase64(peer.identityPk),
    kex_key_signature: signKexKeyBinding(peer),
    level: 4,
  });
  await upsertConversation({ id: CONVERSATION, peerId: peer.userId, updatedAt: 0 });
}

beforeEach(bootstrap);

describe("encryption at rest", () => {
  it("never writes a peer's username in the clear", async () => {
    const raw = await (await timberDb()).getAll(STORE_PEERS);
    expect(JSON.stringify(raw)).not.toContain("tobi");
    // ...but it round-trips correctly.
    expect((await getPeer(peer.userId)).username).toBe("tobi");
  });

  it("never writes message text in the clear", async () => {
    await composeMessage({
      conversationId: CONVERSATION,
      payload: payloads.text("SECRETWORD"),
      id: "m1",
    });
    const raw = await (await timberDb()).getAll(STORE_MESSAGES);
    expect(JSON.stringify(raw)).not.toContain("SECRETWORD");
  });

  it("keeps only ids, timestamps and flags queryable in the clear", async () => {
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("hi"), id: "m1" });
    const [raw] = await (await timberDb()).getAll(STORE_MESSAGES);
    expect(Object.keys(raw).sort()).toEqual([
      "conversationId",
      "createdAt",
      "envelope",
      "id",
      "pending",
      "read",
      "senderId",
    ]);
  });

  it("seals metadata values too", async () => {
    await setMeta("cursor", { since: "2026-08-22T10:00:00Z" });
    const raw = await (await timberDb()).get("meta", "cursor");
    expect(JSON.stringify(raw)).not.toContain("2026-08-22");
    expect(await getMeta("cursor")).toEqual({ since: "2026-08-22T10:00:00Z" });
  });

  it("cannot be read once the session is locked", async () => {
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("hi"), id: "m1" });
    closeSession();
    await expect(getPeer(peer.userId)).rejects.toThrow(/locked/i);
  });

  it("refuses a contact whose pinned identity or chat key changes", async () => {
    const replacementKey = peer.kexPk.slice();
    replacementKey[0] ^= 1;
    await expect(putPeer({
      id: peer.userId,
      username: "tobi",
      kex_pk: bytesToBase64(replacementKey),
      identity_pk: bytesToBase64(peer.identityPk),
      kex_key_signature: signKexKeyBinding({ ...peer, kexPk: replacementKey }),
    })).rejects.toThrow(PeerKeyVerificationError);
  });
});

describe("messages", () => {
  it("round-trips a composed message", async () => {
    await composeMessage({
      conversationId: CONVERSATION,
      payload: payloads.text("meet me by the old oak"),
      id: "m1",
      createdAt: 1000,
    });
    const [message] = await messagesFor(CONVERSATION);
    expect(message.payload.body).toBe("meet me by the old oak");
    expect(message.senderId).toBe(me.userId);
    expect(message.pending).toBe(true);
  });

  it("decrypts a message sealed by the peer", async () => {
    // What arrives over the websocket: sealed on the peer's device.
    const peerKey = await (async () => {
      const { conversationKey } = await import("../crypto/envelope.js");
      return conversationKey({
        conversationId: CONVERSATION,
        kexSk: peer.kexSk,
        peerKexPk: me.kexPk,
        userId: peer.userId,
        peerUserId: me.userId,
      });
    })();
    const envelope = seal({
      key: peerKey,
      conversationId: CONVERSATION,
      senderId: peer.userId,
      payload: payloads.text("on my way"),
    });
    await putMessage({
      id: "in1",
      conversationId: CONVERSATION,
      senderId: peer.userId,
      createdAt: 2000,
      envelope,
    });

    const [message] = await messagesFor(CONVERSATION);
    expect(message.payload.body).toBe("on my way");
  });

  it("orders a page oldest to newest", async () => {
    for (const [id, at] of [["a", 300], ["b", 100], ["c", 200]]) {
      await composeMessage({ conversationId: CONVERSATION, payload: payloads.text(id), id, createdAt: at });
    }
    expect((await messagesFor(CONVERSATION)).map((m) => m.payload.body)).toEqual(["b", "c", "a"]);
  });

  it("pages backwards through history with `before`", async () => {
    for (let i = 1; i <= 5; i += 1) {
      await composeMessage({
        conversationId: CONVERSATION,
        payload: payloads.text(`m${i}`),
        id: `m${i}`,
        createdAt: i * 100,
      });
    }
    const newest = await messagesFor(CONVERSATION, { limit: 2 });
    expect(newest.map((m) => m.payload.body)).toEqual(["m4", "m5"]);

    const older = await messagesFor(CONVERSATION, { limit: 2, before: newest[0].createdAt });
    expect(older.map((m) => m.payload.body)).toEqual(["m2", "m3"]);
  });

  it("keeps conversations separate", async () => {
    const other = "11111111-1111-8222-8333-444455556666";
    await upsertConversation({ id: other, peerId: peer.userId, updatedAt: 0 });
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("here"), id: "a" });
    await composeMessage({ conversationId: other, payload: payloads.text("there"), id: "b" });

    expect((await messagesFor(CONVERSATION)).map((m) => m.payload.body)).toEqual(["here"]);
    expect((await messagesFor(other)).map((m) => m.payload.body)).toEqual(["there"]);
  });

  it("surfaces an unopenable message instead of dropping it", async () => {
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("hi"), id: "m1" });
    const db = await timberDb();
    const record = await db.get(STORE_MESSAGES, "m1");
    const bytes = base64ToBytes(record.envelope.ciphertext);
    bytes[0] ^= 1;
    await db.put(STORE_MESSAGES, {
      ...record,
      envelope: { ...record.envelope, ciphertext: bytes.toString("base64") },
    });

    const [message] = await messagesFor(CONVERSATION);
    expect(message.undecryptable).toBe(true);
    expect(message.reason).toBe("verification-failed");
  });

  it("folds encrypted edits, reactions, pins, and retractions without saving plaintext controls", async () => {
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("original"), id: "base" });
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.reaction("base", "❤️"), id: "reaction" });
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.edit("base", "edited"), id: "edit" });
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.pin("base", true), id: "pin" });
    const shown = presentMessages(await messagesFor(CONVERSATION));
    expect(shown).toHaveLength(1);
    expect(shown[0].payload.body).toBe("edited");
    expect(shown[0].pinned).toBe(true);
    expect(shown[0].reactions["❤️"]).toEqual([me.userId]);

    await composeMessage({ conversationId: CONVERSATION, payload: payloads.delete("base"), id: "delete" });
    expect(presentMessages(await messagesFor(CONVERSATION))[0].deleted).toBe(true);
    expect(JSON.stringify(await (await timberDb()).getAll(STORE_MESSAGES))).not.toContain("edited");
  });

  it("searches only after locally opening encrypted envelopes", async () => {
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("meet at cedar library"), id: "searchable" });
    const raw = await (await timberDb()).getAll(STORE_MESSAGES);
    expect(JSON.stringify(raw)).not.toContain("cedar library");
    expect((await searchMessages("cedar")).map((message) => message.id)).toEqual(["searchable"]);
  });

  it("reports waiting-for-key when the peer's public key is not cached yet", async () => {
    const orphan = "22222222-1111-8222-8333-444455556666";
    await upsertConversation({ id: orphan, peerId: "33333333-1111-8222-8333-444455556666" });
    expect(await keyForConversation(orphan)).toBeNull();
    await putMessage({
      id: "o1",
      conversationId: orphan,
      senderId: "33333333-1111-8222-8333-444455556666",
      createdAt: 1,
      envelope: { envelope_version: 1, nonce: "", ciphertext: "" },
    });
    const [message] = await messagesFor(orphan);
    expect(message.undecryptable).toBe(true);
    expect(message.reason).toBe("waiting-for-key");
  });
});

describe("outbox", () => {
  it("lists pending messages oldest first", async () => {
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("b"), id: "b", createdAt: 200 });
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("a"), id: "a", createdAt: 100 });
    expect((await pendingMessages()).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("swaps an optimistic message for the server-confirmed one", async () => {
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("hi"), id: "temp-1", createdAt: 100 });
    const [before] = await messagesFor(CONVERSATION);

    await confirmMessage("temp-1", {
      id: "server-1",
      conversationId: CONVERSATION,
      senderId: me.userId,
      createdAt: 100,
      envelope: before.envelope ?? (await (await timberDb()).get(STORE_MESSAGES, "temp-1"))?.envelope,
      read: true,
    });

    const messages = await messagesFor(CONVERSATION);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("server-1");
    expect(messages[0].pending).toBe(false);
    expect(await pendingMessages()).toHaveLength(0);
  });
});

describe("unread tracking", () => {
  it("counts only unread messages from the peer", async () => {
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("mine"), id: "m1" });
    await putMessage({
      id: "in1",
      conversationId: CONVERSATION,
      senderId: peer.userId,
      createdAt: 2000,
      envelope: { envelope_version: 1, nonce: "", ciphertext: "" },
    });
    // My own messages are never unread, even though they are stored the same way.
    expect(await unreadCount(CONVERSATION)).toBe(1);
  });

  it("clears the count on markRead", async () => {
    await putMessage({
      id: "in1",
      conversationId: CONVERSATION,
      senderId: peer.userId,
      createdAt: 2000,
      envelope: { envelope_version: 1, nonce: "", ciphertext: "" },
    });
    expect(await markRead(CONVERSATION)).toEqual(["in1"]);
    expect(await unreadCount(CONVERSATION)).toBe(0);
  });
});

describe("conversation list", () => {
  it("orders by most recent activity", async () => {
    const other = "11111111-1111-8222-8333-444455556666";
    await upsertConversation({ id: other, peerId: peer.userId, updatedAt: 0 });
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("older"), id: "a", createdAt: 100 });
    await composeMessage({ conversationId: other, payload: payloads.text("newer"), id: "b", createdAt: 900 });

    expect((await listConversations()).map((c) => c.id)).toEqual([other, CONVERSATION]);
  });

  it("merges updates instead of replacing the record", async () => {
    await upsertConversation({ id: CONVERSATION, draft: "half-written" });
    const conversation = await getConversation(CONVERSATION);
    expect(conversation.peerId).toBe(peer.userId);
    expect(conversation.draft).toBe("half-written");
  });

  it("exposes the newest message as the list preview", async () => {
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("first"), id: "a", createdAt: 100 });
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("latest"), id: "b", createdAt: 200 });
    expect((await lastMessage(CONVERSATION)).payload.body).toBe("latest");
  });

  it("removes a deleted friendship's local conversation, ciphertext, and peer cache", async () => {
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("goodbye"), id: "gone" });
    await deleteConversation(CONVERSATION, peer.userId);

    expect(await getConversation(CONVERSATION)).toBeNull();
    expect(await messagesFor(CONVERSATION)).toEqual([]);
    expect(await getPeer(peer.userId)).toBeNull();
  });
});
