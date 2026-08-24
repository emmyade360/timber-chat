import { describe, expect, it } from "vitest";
import { filterConversations } from "./chatFilter.js";

const conversations = [
  { id: "one", peerUsername: "MangoTree" },
  { id: "two", peerUsername: "cedar" },
  { id: "three", peerUsername: "River Stone" },
];

describe("chat friend search", () => {
  it("matches friend usernames without changing their chat order", () => {
    expect(filterConversations(conversations, "r").map((chat) => chat.id))
      .toEqual(["one", "two", "three"]);
    expect(filterConversations(conversations, "river").map((chat) => chat.id))
      .toEqual(["three"]);
  });

  it("is case-insensitive and returns the original list for a blank query", () => {
    expect(filterConversations(conversations, "CEDAR").map((chat) => chat.id))
      .toEqual(["two"]);
    expect(filterConversations(conversations, "   ")).toBe(conversations);
  });
});
