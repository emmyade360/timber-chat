// The notification target has to survive the gap between the page loading and
// the vault being unlocked, because a cold start from a notification always
// goes through the PIN screen before the shell exists.

import { beforeEach, describe, expect, it, vi } from "vitest";

async function load(url, { serviceWorker = true } = {}) {
  vi.resetModules();
  const parsed = new URL(url);
  const replaceState = vi.fn();
  const swListeners = {};
  vi.stubGlobal("window", {
    location: { search: parsed.search, pathname: parsed.pathname, hash: parsed.hash },
    history: { state: null, replaceState },
  });
  vi.stubGlobal("navigator", serviceWorker
    ? { serviceWorker: { addEventListener: (type, fn) => { swListeners[type] = fn; } } }
    : {});
  const module = await import("./deepLink.js");
  module.startDeepLinks();
  return { ...module, replaceState, swListeners };
}

beforeEach(() => vi.unstubAllGlobals());

describe("cold start from a notification", () => {
  it("latches the conversation and scrubs it from the URL", async () => {
    const { consumePendingTarget, replaceState } = await load("https://timber.example/?c=conv-1");
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0][2]).toBe("/");
    expect(consumePendingTarget()).toEqual({ kind: "chat", conversationId: "conv-1" });
  });

  it("distinguishes a call from a message", async () => {
    const { consumePendingTarget } = await load("https://timber.example/?call=1&c=conv-1");
    expect(consumePendingTarget()).toEqual({ kind: "call", conversationId: "conv-1" });
  });

  it("hands the target over exactly once", async () => {
    const { consumePendingTarget } = await load("https://timber.example/?c=conv-1");
    expect(consumePendingTarget()).not.toBeNull();
    // The shell consumes on mount; a second read must not reopen the chat.
    expect(consumePendingTarget()).toBeNull();
  });

  it("keeps unrelated query parameters", async () => {
    const { replaceState } = await load("https://timber.example/?c=conv-1&invite=ABC");
    expect(replaceState.mock.calls[0][2]).toBe("/?invite=ABC");
  });

  it("does nothing on an ordinary visit", async () => {
    const { consumePendingTarget, replaceState } = await load("https://timber.example/");
    expect(consumePendingTarget()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe("a tap while the app is already open", () => {
  it("delivers the target to subscribers", async () => {
    const { subscribePendingTarget, swListeners } = await load("https://timber.example/");
    const seen = [];
    subscribePendingTarget((target) => seen.push(target));

    swListeners.message({ data: { type: "timber-open", target: { kind: "chat", conversationId: "c9" } } });

    expect(seen).toEqual([{ kind: "chat", conversationId: "c9" }]);
  });

  it("ignores unrelated service worker messages", async () => {
    const { subscribePendingTarget, swListeners } = await load("https://timber.example/");
    const seen = [];
    subscribePendingTarget((target) => seen.push(target));

    swListeners.message({ data: { type: "workbox-something" } });

    expect(seen).toEqual([]);
  });

  it("survives a browser with no service worker", async () => {
    const { consumePendingTarget } = await load("https://timber.example/?c=conv-1", { serviceWorker: false });
    expect(consumePendingTarget()).toEqual({ kind: "chat", conversationId: "conv-1" });
  });
});
