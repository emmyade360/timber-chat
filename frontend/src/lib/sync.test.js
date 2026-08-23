import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHistory } from "./api.js";
import { messagesFor, putMessage } from "../db/localStore.js";
import { backfill } from "./sync.js";

vi.mock("./api.js", () => ({
  getConversations: vi.fn(),
  getCurrentUser: vi.fn(),
  getFriends: vi.fn(),
  getGrowth: vi.fn(),
  getHistory: vi.fn(),
}));

vi.mock("../db/localStore.js", () => ({
  composeMessage: vi.fn(),
  confirmMessage: vi.fn(),
  deleteConversation: vi.fn(),
  deletePeer: vi.fn(),
  getConversation: vi.fn(),
  listConversations: vi.fn(),
  markRead: vi.fn(),
  messagesFor: vi.fn(),
  presentMessages: vi.fn((messages) => messages),
  putMessage: vi.fn(),
  putPeer: vi.fn(),
  PeerKeyVerificationError: class PeerKeyVerificationError extends Error {},
  unreadCount: vi.fn(),
  upsertConversation: vi.fn(),
}));

vi.mock("../store/chatStore.js", () => ({
  useChatStore: { getState: vi.fn(() => ({ removeConversation: vi.fn() })) },
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
