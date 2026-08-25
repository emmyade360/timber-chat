// Enabling alerts is one browser permission covering two mechanisms. The rules
// that matter are that it is asked for once, that a failure in one mechanism
// does not cost the other, and that a refusal changes nothing.

import { beforeEach, describe, expect, it, vi } from "vitest";

const notifications = vi.hoisted(() => ({
  notificationSettings: vi.fn(async () => ({ enabled: false })),
  updateNotificationSettings: vi.fn(async (patch) => ({ enabled: false, ...patch })),
}));
const push = vi.hoisted(() => ({
  enablePushAlerts: vi.fn(async () => ({})),
  pushAlertsEnabled: vi.fn(async () => false),
  pushSupported: vi.fn(() => true),
}));

vi.mock("./notifications.js", () => notifications);
vi.mock("./push.js", () => push);

const { alertsBlocked, alertsFullyEnabled, alertsUndecided, enableAllAlerts } =
  await import("./alerts.js");

/** Stand in for the browser's Notification API. */
function withPermission(permission, onRequest) {
  vi.stubGlobal("Notification", {
    permission,
    requestPermission: vi.fn(onRequest ?? (async () => permission)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  notifications.notificationSettings.mockResolvedValue({ enabled: false });
  push.pushAlertsEnabled.mockResolvedValue(false);
  push.pushSupported.mockReturnValue(true);
  push.enablePushAlerts.mockResolvedValue({});
});

describe("turning alerts on", () => {
  it("asks for permission once and enables both mechanisms", async () => {
    withPermission("default", async () => "granted");

    const result = await enableAllAlerts();

    expect(Notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(notifications.updateNotificationSettings).toHaveBeenCalledWith({ enabled: true });
    expect(push.enablePushAlerts).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ notifications: true, push: true });
  });

  it("keeps in-app notifications when push cannot be set up", async () => {
    // An unconfigured VAPID key or a browser with no working push service must
    // not cost someone the notifications that do work.
    withPermission("default", async () => "granted");
    push.enablePushAlerts.mockRejectedValue(new Error("no push service"));

    const result = await enableAllAlerts();

    expect(notifications.updateNotificationSettings).toHaveBeenCalledWith({ enabled: true });
    expect(result).toEqual({ notifications: true, push: false });
  });

  it("changes nothing when the person refuses", async () => {
    withPermission("default", async () => "denied");

    await expect(enableAllAlerts()).rejects.toThrow(/not allowed/i);
    expect(notifications.updateNotificationSettings).not.toHaveBeenCalled();
    expect(push.enablePushAlerts).not.toHaveBeenCalled();
  });

  it("does not try to subscribe on a browser without push", async () => {
    withPermission("default", async () => "granted");
    push.pushSupported.mockReturnValue(false);

    const result = await enableAllAlerts();

    expect(push.enablePushAlerts).not.toHaveBeenCalled();
    expect(result).toEqual({ notifications: true, push: false });
  });

  it("reports a browser with no notification support rather than throwing oddly", async () => {
    vi.stubGlobal("Notification", undefined);
    await expect(enableAllAlerts()).rejects.toThrow(/does not support/i);
  });
});

describe("whether this device is reachable", () => {
  it("is not reachable on in-app notifications alone", async () => {
    // Push is the half that survives the app being closed, which is the case
    // people actually mean by "notify me".
    withPermission("granted");
    notifications.notificationSettings.mockResolvedValue({ enabled: true });
    push.pushAlertsEnabled.mockResolvedValue(false);

    expect(await alertsFullyEnabled()).toBe(false);
  });

  it("is reachable with both", async () => {
    withPermission("granted");
    notifications.notificationSettings.mockResolvedValue({ enabled: true });
    push.pushAlertsEnabled.mockResolvedValue(true);

    expect(await alertsFullyEnabled()).toBe(true);
  });

  it("does not hold a browser without push to an impossible standard", async () => {
    withPermission("granted");
    notifications.notificationSettings.mockResolvedValue({ enabled: true });
    push.pushSupported.mockReturnValue(false);

    expect(await alertsFullyEnabled()).toBe(true);
  });

  it("is not reachable without permission, whatever the stored settings say", async () => {
    withPermission("denied");
    notifications.notificationSettings.mockResolvedValue({ enabled: true });

    expect(await alertsFullyEnabled()).toBe(false);
  });
});

describe("whether it is still worth asking", () => {
  it("is undecided only before a choice is made", async () => {
    withPermission("default");
    expect(alertsUndecided()).toBe(true);
    expect(alertsBlocked()).toBe(false);

    withPermission("denied");
    expect(alertsUndecided()).toBe(false);
    expect(alertsBlocked()).toBe(true);

    withPermission("granted");
    expect(alertsUndecided()).toBe(false);
    expect(alertsBlocked()).toBe(false);
  });
});
