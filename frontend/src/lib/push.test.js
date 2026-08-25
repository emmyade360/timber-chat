import { beforeEach, describe, expect, it, vi } from "vitest";

const local = vi.hoisted(() => ({
  getMeta: vi.fn(async () => null),
  setMeta: vi.fn(async () => {}),
}));
const api = vi.hoisted(() => ({
  savePushSubscription: vi.fn(async () => {}),
  removePushSubscription: vi.fn(async () => {}),
}));

vi.mock("../db/localStore.js", () => local);
vi.mock("./api.js", () => api);

const { disablePushAlerts, enablePushAlerts, ensurePushSubscription, pushReadiness, PUSH_STATUS } =
  await import("./push.js");

const endpoint = "https://fcm.example.test/send/device-1";
const otherEndpoint = "https://fcm.example.test/send/device-2";

function subscription(url = endpoint) {
  return {
    endpoint: url,
    toJSON: () => ({ endpoint: url, keys: { p256dh: "public", auth: "auth" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function browser(registration, permission = "granted") {
  vi.stubGlobal("window", { PushManager: class {}, Notification: {} });
  vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve(registration) } });
  vi.stubGlobal("Notification", { permission, requestPermission: vi.fn(async () => "granted") });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  local.getMeta.mockResolvedValue(null);
  api.savePushSubscription.mockResolvedValue({});
  api.removePushSubscription.mockResolvedValue({});
});

describe("push subscription lifecycle", () => {
  it("reuses an existing subscription rather than duplicating it", async () => {
    const existing = subscription();
    const registration = { pushManager: {
      getSubscription: vi.fn(async () => existing),
      subscribe: vi.fn(),
    } };
    browser(registration);

    await enablePushAlerts();

    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.savePushSubscription).toHaveBeenCalledWith(existing.toJSON());
    expect(local.setMeta).toHaveBeenCalledWith("push-endpoint", { endpoint });
  });

  it("disables push locally and removes the server registration", async () => {
    const existing = subscription();
    const registration = { pushManager: {
      getSubscription: vi.fn(async () => existing),
    } };
    browser(registration);

    const result = await disablePushAlerts();

    expect(api.removePushSubscription).toHaveBeenCalledWith(endpoint);
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(local.setMeta).toHaveBeenCalledWith("push-endpoint", null);
    expect(result).toEqual({ serverRemoved: true });
  });

  it("still unsubscribes when the server cleanup request is unavailable", async () => {
    const existing = subscription();
    const registration = { pushManager: {
      getSubscription: vi.fn(async () => existing),
    } };
    browser(registration);
    api.removePushSubscription.mockRejectedValue(new Error("offline"));

    await expect(disablePushAlerts()).resolves.toEqual({ serverRemoved: false });
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(local.setMeta).toHaveBeenCalledWith("push-endpoint", null);
  });

  it("distinguishes unsupported, denied, and missing-key states", async () => {
    vi.stubGlobal("window", {});
    expect(await pushReadiness()).toEqual({ status: PUSH_STATUS.unsupported, endpoint: null });

    browser({ pushManager: { getSubscription: vi.fn() } }, "denied");
    expect(await pushReadiness()).toEqual({ status: PUSH_STATUS.denied, endpoint: null });

    vi.stubEnv("VITE_WEB_PUSH_PUBLIC_KEY", "");
    browser({ pushManager: { getSubscription: vi.fn() } });
    expect(await pushReadiness()).toEqual({ status: PUSH_STATUS.missingKey, endpoint: null });
  });

  it("reports a safe status when the worker never becomes ready", async () => {
    vi.stubGlobal("window", { PushManager: class {}, Notification: {} });
    vi.stubGlobal("navigator", { serviceWorker: { ready: new Promise(() => {}) } });
    vi.stubGlobal("Notification", { permission: "granted" });

    await expect(pushReadiness()).resolves.toEqual({
      status: PUSH_STATUS.unavailable,
      endpoint: null,
    });
  }, 8_000);

  it("uploads a rotated endpoint and removes the old registration", async () => {
    const rotated = subscription(otherEndpoint);
    const registration = { pushManager: {
      getSubscription: vi.fn(async () => rotated),
    } };
    browser(registration);
    local.getMeta.mockResolvedValue({ endpoint });

    await expect(ensurePushSubscription()).resolves.toBe(true);

    expect(api.savePushSubscription).toHaveBeenCalledWith(rotated.toJSON());
    expect(api.removePushSubscription).toHaveBeenCalledWith(endpoint);
    expect(local.setMeta).toHaveBeenCalledWith("push-endpoint", { endpoint: otherEndpoint });
  });
});
