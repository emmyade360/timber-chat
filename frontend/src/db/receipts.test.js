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
  markAcknowledged,
  markReceipt,
  keyForConversation,
  messagesFor,
  putMessage,
  putPeer,
  unacknowledgedMessageIds,
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
    await markAcknowledged(["in1"]);
    expect(await unacknowledgedMessageIds(CONVERSATION, me.userId)).toEqual([]);
  });
});
