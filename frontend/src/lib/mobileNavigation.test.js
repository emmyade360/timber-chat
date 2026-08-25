import { describe, expect, it } from "vitest";
import { mobileTabSelection, notificationMobileDestination } from "./mobileNavigation.js";

describe("three-tab mobile routing", () => {
  it("keeps discovery inside Vault and clears a full-screen thread on tab taps", () => {
    expect(mobileTabSelection("vault")).toEqual({ tab: "vault", vaultPage: "root", chatsPage: "list", closeConversation: true });
    expect(mobileTabSelection("profile")).toEqual({ tab: "profile", vaultPage: null, chatsPage: "list", closeConversation: true });
    expect(mobileTabSelection("anything")).toEqual({ tab: "chats", vaultPage: null, chatsPage: "list", closeConversation: true });
  });

  it("opens friend-request notifications in the retained People surface", () => {
    expect(notificationMobileDestination("people")).toEqual({ tab: "vault", vaultPage: "people" });
    expect(notificationMobileDestination("call")).toEqual({ tab: "chats", vaultPage: null });
  });
});
