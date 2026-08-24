// The landing invite code is a capability. It must leave the address bar on the
// first read, and it must survive a second read -- StrictMode deliberately runs
// state initialisers twice, and losing the code there would silently drop the
// inviter credit and the automatic friendship.

import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadApi(url) {
  vi.resetModules();
  const replaceState = vi.fn();
  const parsed = new URL(url);
  vi.stubGlobal("window", {
    location: { search: parsed.search, pathname: parsed.pathname, hash: parsed.hash, hostname: parsed.hostname },
    history: { state: null, replaceState },
  });
  const { inviteCodeFromUrl } = await import("./api.js");
  return { inviteCodeFromUrl, replaceState };
}

describe("landing invite code", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("returns the code and removes it from the URL", async () => {
    const { inviteCodeFromUrl, replaceState } = await loadApi("https://timber.example/?invite=timber42");
    expect(inviteCodeFromUrl()).toBe("TIMBER42");
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0][2]).toBe("/");
  });

  it("returns the same code on a repeated read and scrubs only once", async () => {
    const { inviteCodeFromUrl, replaceState } = await loadApi("https://timber.example/?invite=timber42");
    expect(inviteCodeFromUrl()).toBe("TIMBER42");
    expect(inviteCodeFromUrl()).toBe("TIMBER42");
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it("keeps any unrelated query parameters", async () => {
    const { inviteCodeFromUrl, replaceState } = await loadApi("https://timber.example/join?invite=abc&ref=x");
    expect(inviteCodeFromUrl()).toBe("ABC");
    expect(replaceState.mock.calls[0][2]).toBe("/join?ref=x");
  });

  it("does not touch the URL when there is no invite", async () => {
    const { inviteCodeFromUrl, replaceState } = await loadApi("https://timber.example/");
    expect(inviteCodeFromUrl()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
