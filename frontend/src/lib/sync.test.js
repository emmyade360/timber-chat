import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHistory, postReadReceipts } from "./api.js";
import { markReadAck, messagesFor, putMessage, unreadAckedMessageIds } from "../db/localStore.js";
import { acknowledgeRead, backfill, setRealtimeSend } from "./sync.js";

vi.mock("./api.js", () => ({
  getConversations: vi.fn(),
  getCurrentUser: vi.fn(),
  getFriends: vi.fn(),
  getGrowth: vi.fn(),
  getHistory: vi.fn(),
  getReceipts: vi.fn(),
  postReadReceipts: vi.fn(),
}));

vi.mock("../db/localStore.js", () => ({
  composeMessage: vi.fn(),
  confirmMessage: vi.fn(),
  deleteConversation: vi.fn(),
  deletePeer: vi.fn(),
  getConversation: vi.fn(),
  listConversations: vi.fn(),
  getMeta: vi.fn(),
  setMeta: vi.fn(),
  markDeliveredAck: vi.fn(),
  markReadAck: vi.fn(),
  markReceipt: vi.fn(),
  markSeen: vi.fn(),
  messagesFor: vi.fn(),
  pendingMessages: vi.fn(() => []),
  presentMessages: vi.fn((messages) => messages),
  putMessage: vi.fn(),
  putPeer: vi.fn(),
  PeerKeyVerificationError: class PeerKeyVerificationError extends Error {},
  unacknowledgedMessageIds: vi.fn(() => []),
  unreadAckedMessageIds: vi.fn(() => []),
  unreadCount: vi.fn(),
  upsertConversation: vi.fn(),
}));

vi.mock("../store/chatStore.js", () => ({
  useChatStore: { getState: vi.fn(() => ({ removeConversation: vi.fn(), markReceipt: vi.fn(), clearUnread: vi.fn() })) },
}));

vi.mock("../crypto/session.js", () => ({
  currentIdentity: vi.fn(() => ({ userId: "me" })),
}));

describe("realtime backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches every missed history page after a long offline period", async () => {
    const conversationId = "chat-1";
    const serverHistory = Array.from({ length: 170 }, (_, index) => {
      const sequence = index + 1;
      return {
        id: `message-${sequence}`,
        conversation_id: conversationId,
        sender_id: "peer-1",
        created_at: new Date(sequence * 1000).toISOString(),
        envelope_version: 2,
        nonce: "opaque",
        ciphertext: "opaque",
      };
    });
    // This device previously received message 20, then was away for 150 more.
    messagesFor.mockResolvedValue([{ createdAt: 20_000 }]);
    getHistory.mockImplementation(async (_id, { limit, before }) => {
      const cutoff = before ? Date.parse(before) : Number.POSITIVE_INFINITY;
      const page = serverHistory
        .filter((message) => Date.parse(message.created_at) < cutoff)
        .slice(-limit);
      return { data: page };
    });

    await expect(backfill(conversationId)).resolves.toBe(150);

    expect(getHistory).toHaveBeenCalledTimes(4);
    expect(putMessage).toHaveBeenCalledTimes(150);
    expect(putMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "message-21" }));
    expect(putMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "message-170" }));
  });
});

describe("read receipts are never dropped", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRealtimeSend(null);
  });

  it("sends a single batched frame rather than one per message", async () => {
    const sent = [];
    setRealtimeSend((type, payload) => { sent.push([type, payload]); return true; });
    unreadAckedMessageIds.mockResolvedValue(["a", "b", "c"]);

    await acknowledgeRead("c1");

    // One frame. The per-message loop this replaced ran straight into the
    // relay's 60-per-minute ceiling on any real catch-up.
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe("receipt.read");
    expect(sent[0][1]).toEqual({ conversation_id: "c1", message_ids: ["a", "b", "c"] });
    expect(markReadAck).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("falls back to HTTP when the socket will not take it", async () => {
    setRealtimeSend(() => false);
    unreadAckedMessageIds.mockResolvedValue(["a"]);
    postReadReceipts.mockResolvedValue({ data: {} });

    await acknowledgeRead("c1");

    expect(postReadReceipts).toHaveBeenCalledWith("c1", ["a"]);
    expect(markReadAck).toHaveBeenCalledWith(["a"]);
  });

  it("leaves the receipt queued when both transports fail", async () => {
    setRealtimeSend(() => false);
    unreadAckedMessageIds.mockResolvedValue(["a"]);
    postReadReceipts.mockRejectedValue(new Error("offline"));

    await acknowledgeRead("c1");

    // Not marked, so the next sweep retries it. Marking optimistically here is
    // what made a dropped read receipt permanent.
    expect(markReadAck).not.toHaveBeenCalled();
  });

  it("does nothing when there is nothing to acknowledge", async () => {
    const sent = [];
    setRealtimeSend((type) => { sent.push(type); return true; });
    unreadAckedMessageIds.mockResolvedValue([]);

    await acknowledgeRead("c1");

    expect(sent).toHaveLength(0);
    expect(postReadReceipts).not.toHaveBeenCalled();
  });
});
