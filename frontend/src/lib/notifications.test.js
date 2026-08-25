// Three separate defects here all produced the same report — "I turned
// notifications on and I still get nothing" — so each is pinned individually.

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ settings: { enabled: true, digest: false, chats: {} } }));
const tones = vi.hoisted(() => ({ playMessageTone: vi.fn() }));

vi.mock("../db/localStore.js", () => ({
  getMeta: vi.fn(async () => store.settings),
  setMeta: vi.fn(async () => {}),
}));
vi.mock("./callTones.js", () => tones);

const { notifyIncoming } = await import("./notifications.js");

let shown;

/** Stand in for the browser: a Notification constructor and a visibility state. */
function browser({ visible = false, permission = "granted" } = {}) {
  shown = [];
  const Ctor = function Notification(title, options) { shown.push({ title, options }); };
  Ctor.permission = permission;
  Ctor.requestPermission = vi.fn(async () => permission);
  vi.stubGlobal("Notification", Ctor);
  vi.stubGlobal("window", { Notification: Ctor });
  vi.stubGlobal("document", { visibilityState: visible ? "visible" : "hidden", hidden: !visible });
}

const arrival = (overrides = {}) => ({
  conversationId: "c1",
  username: "cedarwood",
  message: { payload: { t: "text" } },
  isActive: false,
  mine: false,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  store.settings = { enabled: true, digest: false, chats: {} };
});

describe("a message arriving while the app is hidden", () => {
  it("raises a notification", async () => {
    browser({ visible: false });
    await notifyIncoming(arrival());
    expect(shown).toHaveLength(1);
    expect(shown[0].options.body).toContain("@cedarwood");
  });

  it("re-alerts for every message in a thread, not just the first", async () => {
    // Same tag with renotify:false replaces the previous notification in
    // silence. The thread would alert once and then appear to stop working.
    browser({ visible: false });
    await notifyIncoming(arrival());
    await notifyIncoming(arrival());
    expect(shown).toHaveLength(2);
    for (const entry of shown) expect(entry.options.renotify).toBe(true);
  });

  it("still notifies when that chat is mounted but nobody is looking", async () => {
    // A phone locks with a thread open: the screen is still mounted, so the
    // caller reports it active. The relay also still sees the socket, so no
    // push is sent either -- this is the only cue left.
    browser({ visible: false });
    await notifyIncoming(arrival({ isActive: false }));
    expect(shown).toHaveLength(1);
  });

  it("stays silent for a muted conversation", async () => {
    browser({ visible: false });
    store.settings = { enabled: true, digest: false, chats: { c1: "muted" } };
    await notifyIncoming(arrival());
    expect(shown).toHaveLength(0);
  });

  it("stays silent for your own message", async () => {
    browser({ visible: false });
    await notifyIncoming(arrival({ mine: true }));
    expect(shown).toHaveLength(0);
    expect(tones.playMessageTone).not.toHaveBeenCalled();
  });
});

describe("a message arriving while the app is on screen", () => {
  it("plays a tone instead of an OS notification", async () => {
    // An OS popup would be redundant when the app is visible, but suppressing
    // it left the arrival with no cue at all.
    browser({ visible: true });
    await notifyIncoming(arrival());
    expect(tones.playMessageTone).toHaveBeenCalledTimes(1);
    expect(shown).toHaveLength(0);
  });

  it("says nothing when the person is looking at that very conversation", async () => {
    browser({ visible: true });
    await notifyIncoming(arrival({ isActive: true }));
    expect(tones.playMessageTone).not.toHaveBeenCalled();
    expect(shown).toHaveLength(0);
  });

  it("plays the tone even if OS notifications were never permitted", async () => {
    // The tone is not gated on a permission it does not need.
    browser({ visible: true, permission: "denied" });
    store.settings = { enabled: false, digest: false, chats: {} };
    await notifyIncoming(arrival());
    expect(tones.playMessageTone).toHaveBeenCalledTimes(1);
  });
});
