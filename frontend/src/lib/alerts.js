// Turning notifications on, as one act.
//
// A browser grants notification permission once, and Timber needs it for two
// separate mechanisms: the in-page Notification it raises while the tab is
// alive but hidden, and the Web Push subscription that reaches the device when
// the app is closed entirely. Asking twice for the same permission, through two
// settings toggles, meant most people ended up with neither -- and the two
// mechanisms cover different moments, so having one without the other leaves a
// hole rather than half a feature.
//
// The switches in Settings still control each mechanism separately. This is the
// single door in.

import { notificationSettings, updateNotificationSettings } from "./notifications.js";
import { enablePushAlerts, pushAlertsEnabled, pushReadiness, pushSupported, PUSH_STATUS } from "./push.js";

/** Nothing has been asked yet, so it is still reasonable to offer. */
export function alertsUndecided() {
  return typeof Notification !== "undefined" && Notification.permission === "default";
}

export function alertsBlocked() {
  return typeof Notification !== "undefined" && Notification.permission === "denied";
}

export function pushStatusMessage(status) {
  return ({
    [PUSH_STATUS.unsupported]: "This browser cannot deliver notifications while Timber is closed.",
    [PUSH_STATUS.missingKey]: "Background notifications are not configured for this deployment yet.",
    [PUSH_STATUS.denied]: "Notifications are blocked for this site. Allow them in your browser settings, then retry.",
    [PUSH_STATUS.unavailable]: "The notification service worker is not ready. Keep Timber open briefly, then retry.",
    [PUSH_STATUS.notSubscribed]: "Permission is granted; this device still needs to register for background alerts.",
    [PUSH_STATUS.ready]: "Messages and calls can reach this device while Timber is closed.",
  })[status] ?? "Background notification status is unavailable.";
}

export async function alertReadiness() {
  const [settings, push] = await Promise.all([
    notificationSettings().catch(() => ({ enabled: false })),
    pushReadiness(),
  ]);
  return { enabled: Boolean(settings.enabled), push };
}

/**
 * Whether this device is set up to reach the person at all.
 *
 * Push is the part that survives the app being closed, so a device with only
 * in-page notifications is not really reachable and should still be offered the
 * upgrade.
 */
export async function alertsFullyEnabled() {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  const [settings, push] = await Promise.all([
    notificationSettings().catch(() => ({ enabled: false })),
    // `navigator.serviceWorker.ready` pends forever rather than rejecting when
    // no worker ever registers. This answer gates a modal, so it must not be
    // the thing that hangs.
    Promise.race([
      pushAlertsEnabled().catch(() => false),
      new Promise((resolve) => { setTimeout(() => resolve(false), 3000); }),
    ]),
  ]);
  return Boolean(settings.enabled) && (push || !pushSupported());
}

/**
 * Ask once, then turn on everything the browser will allow.
 *
 * Push can fail on its own -- an unconfigured VAPID key, a browser that has the
 * API but no working push service -- and that must not cost the person their
 * in-app notifications, which work regardless. So the two are settled
 * independently and the result says what actually happened.
 */
export async function enableAllAlerts() {
  if (typeof Notification === "undefined") {
    throw new Error("This browser does not support notifications.");
  }
  // Permission requests must remain tied to the caller's click/tap. Do not
  // invoke the browser prompt again when it is already granted.
  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications were not allowed by this browser.");
  }

  await updateNotificationSettings({ enabled: true });

  let push = false;
  if (pushSupported()) {
    try {
      await enablePushAlerts();
      push = true;
    } catch {
      // Reachable while open, not while closed. Settings can retry it.
    }
  }
  return { notifications: true, push };
}
