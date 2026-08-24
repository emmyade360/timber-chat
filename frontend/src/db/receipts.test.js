// Delivery and read receipts.
//
// The rules that matter are the ones about ordering: receipts only ever move
// forward, and a backfill that fetches an older copy of a message must not walk
// the sender's ticks backwards.

import { beforeEach, describe, expect, it } from "vitest";
import { createMnemonic, deriveIdentity, signKexKeyBinding } from "../crypto/identity.js";
import { closeSession, openSession } from "../crypto/session.js";
import { payloads } from "../crypto/envelope.js";
import { bytesToBase64 } from "../crypto/bytes.js";
import { destroyTimberDb } from "./timberDb.js";
import {
  composeMessage,
  getMessage,
  markDeliveredAck,
  markReadAck,
  markReceipt,
  keyForConversation,
  messagesFor,
  putMessage,
  putPeer,
  markSeen,
  unacknowledgedMessageIds,
  unreadAckedMessageIds,
  upsertConversation,
} from "./localStore.js";
import { seal } from "../crypto/envelope.js";

const CONVERSATION = "0f5f2b6a-1111-8222-8333-444455556666";
let me;
let peer;

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

/** A message the peer sent us, sealed with the shared conversation key. */
async function inboundMessage(id, body, createdAt = Date.now()) {
  const key = await keyForConversation(CONVERSATION);
  const envelope = seal({
    key,
    conversationId: CONVERSATION,
    senderId: peer.userId,
    payload: payloads.text(body),
  });
  await putMessage({
    id,
    conversationId: CONVERSATION,
    senderId: peer.userId,
    createdAt,
    envelope,
    read: false,
  });
}

const only = async (id) => (await messagesFor(CONVERSATION)).find((entry) => entry.id === id);

describe("receipt state", () => {
  it("starts a sent message with neither receipt, so it shows one tick", async () => {
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("hi"), id: "m1" });
    const message = await only("m1");
    expect(message.deliveredAt).toBeNull();
    expect(message.readAt).toBeNull();
  });

  it("records delivery and then read", async () => {
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("hi"), id: "m1" });
    expect(await markReceipt(["m1"], "deliveredAt", 1000)).toEqual(["m1"]);
    expect((await only("m1")).deliveredAt).toBe(1000);
    await markReceipt(["m1"], "readAt", 2000);
    expect((await only("m1")).readAt).toBe(2000);
  });

  it("backfills delivery when a read receipt arrives first", async () => {
    // Two events, one socket, no ordering guarantee. A message must never show
    // three ticks while claiming it was never delivered.
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("hi"), id: "m1" });
    await markReceipt(["m1"], "readAt", 2000);
    const message = await only("m1");
    expect(message.readAt).toBe(2000);
    expect(message.deliveredAt).toBe(2000);
  });

  it("never moves a receipt backwards or re-reports one", async () => {
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("hi"), id: "m1" });
    await markReceipt(["m1"], "deliveredAt", 1000);
    expect(await markReceipt(["m1"], "deliveredAt", 5000)).toEqual([]);
    expect((await only("m1")).deliveredAt).toBe(1000);
  });

  it("keeps receipts when the same message is stored again by a backfill", async () => {
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("hi"), id: "m1" });
    await markReceipt(["m1"], "readAt", 2000);
    const stored = await getMessage("m1");
    // Exactly what backfill does: re-store the row as the server described it,
    // with no receipt fields of its own.
    await putMessage({
      id: "m1",
      conversationId: CONVERSATION,
      senderId: me.userId,
      createdAt: stored.createdAt,
      envelope: stored.envelope,
      read: true,
    });
    const after = await only("m1");
    expect(after.readAt).toBe(2000);
    expect(after.deliveredAt).toBe(2000);
  });
});

describe("delivery acknowledgement sweep", () => {
  it("reports the peer's messages that this device has not acknowledged", async () => {
    await inboundMessage("in1", "one");
    await inboundMessage("in2", "two");
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("mine"), id: "m1" });

    const pending = await unacknowledgedMessageIds(CONVERSATION, me.userId);
    // Our own message is never acknowledged back to ourselves.
    expect(pending.sort()).toEqual(["in1", "in2"]);
  });

  it("stops reporting a message once the relay has taken the receipt", async () => {
    await inboundMessage("in1", "one");
    await markDeliveredAck(["in1"]);
    expect(await unacknowledgedMessageIds(CONVERSATION, me.userId)).toEqual([]);
  });
});

describe("read receipts survive a failed send", () => {
  // The bug users hit: `read` meant both "the user saw it" and "we told the
  // sender". Once it was set the receipt could never be retried, so a message
  // the peer had plainly read sat on two ticks forever.
  it("keeps reporting a seen message until the receipt is acknowledged", async () => {
    await inboundMessage("in1", "hello");
    await markSeen(CONVERSATION, me.userId);

    // Seen, but the sender has not been told: still queued.
    expect(await unreadAckedMessageIds(CONVERSATION, me.userId)).toEqual(["in1"]);
    // Still queued on the next sweep, because nothing acknowledged it.
    expect(await unreadAckedMessageIds(CONVERSATION, me.userId)).toEqual(["in1"]);

    await markReadAck(["in1"]);
    expect(await unreadAckedMessageIds(CONVERSATION, me.userId)).toEqual([]);
  });

  it("does not queue a read receipt for a message the user has not seen", async () => {
    await inboundMessage("in1", "hello");
    expect(await unreadAckedMessageIds(CONVERSATION, me.userId)).toEqual([]);
  });

  it("never queues a read receipt for your own message", async () => {
    await composeMessage({ conversationId: CONVERSATION, payload: payloads.text("mine"), id: "m1" });
    await markSeen(CONVERSATION, me.userId);
    expect(await unreadAckedMessageIds(CONVERSATION, me.userId)).toEqual([]);
  });

  it("keeps the delivery and read queues independent", async () => {
    await inboundMessage("in1", "hello");
    await markDeliveredAck(["in1"]);
    await markSeen(CONVERSATION, me.userId);
    // Delivery told, read not yet.
    expect(await unacknowledgedMessageIds(CONVERSATION, me.userId)).toEqual([]);
    expect(await unreadAckedMessageIds(CONVERSATION, me.userId)).toEqual(["in1"]);
  });
});

describe("receipts that arrive before their message", () => {
  // The peer acknowledges the moment the relay echoes a message, which can beat
  // our own optimistic row being swapped for its real id. Dropping the receipt
  // there left a tick permanently behind.
  it("applies a receipt parked before the message was stored", async () => {
    await markReceipt(["later"], "deliveredAt", 4242);

    const key = await keyForConversation(CONVERSATION);
    const envelope = seal({
      key,
      conversationId: CONVERSATION,
      senderId: me.userId,
      payload: payloads.text("hi"),
    });
    await putMessage({
      id: "later",
      conversationId: CONVERSATION,
      senderId: me.userId,
      createdAt: 1000,
      envelope,
    });

    const stored = await getMessage("later");
    expect(stored.deliveredAt).toBe(4242);
  });

  it("treats a parked read receipt as implying delivery", async () => {
    await markReceipt(["later"], "readAt", 5000);
    const key = await keyForConversation(CONVERSATION);
    await putMessage({
      id: "later",
      conversationId: CONVERSATION,
      senderId: me.userId,
      createdAt: 1000,
      envelope: seal({ key, conversationId: CONVERSATION, senderId: me.userId, payload: payloads.text("hi") }),
    });
    const stored = await getMessage("later");
    expect(stored.readAt).toBe(5000);
    expect(stored.deliveredAt).toBe(5000);
  });
});

describe("acknowledgement flags survive a re-store", () => {
  it("does not resurrect an already-acknowledged message on backfill", async () => {
    await inboundMessage("in1", "hello");
    await markDeliveredAck(["in1"]);
    const stored = await getMessage("in1");

    // Exactly what backfill does: re-store the row as the server described it.
    await putMessage({
      id: "in1",
      conversationId: CONVERSATION,
      senderId: peer.userId,
      createdAt: stored.createdAt,
      envelope: stored.envelope,
    });

    expect(await unacknowledgedMessageIds(CONVERSATION, me.userId)).toEqual([]);
  });
});
