// Privacy-first browser notifications. Preferences live in encrypted local
// metadata, and notifications intentionally never include decrypted message text.

import { getMeta, setMeta } from "../db/localStore.js";

const SETTINGS_KEY = "notification-settings";
const DIGEST_KEY = "notification-digest";
const CHECK_IN_KEY = "notification-last-check-in";
const defaults = { enabled: false, digest: false, checkIns: false, chats: {} };

export async function notificationSettings() {
  return { ...defaults, ...((await getMeta(SETTINGS_KEY)) ?? {}) };
}

export async function updateNotificationSettings(patch) {
  const next = { ...(await notificationSettings()), ...patch };
  await setMeta(SETTINGS_KEY, next);
  return next;
}

export async function setChatNotification(conversationId, mode) {
  const settings = await notificationSettings();
  const chats = { ...settings.chats, [conversationId]: mode };
  return updateNotificationSettings({ chats });
}

export async function requestNotificationPermission() {
  if (!("Notification" in window)) throw new Error("This browser does not support notifications.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications were not allowed by this browser.");
  return updateNotificationSettings({ enabled: true });
}

/**
 * Whether an OS-level popup is warranted right now.
 *
 * Two gates. The master switch the user granted permission behind, and whether
 * the app is actually on screen: if Timber is the visible tab then the People
 * badge, the call overlay, and the chat list have already said it, and a second
 * announcement on top of that is just noise.
 */
async function canNotify({ requireHidden = true } = {}) {
  if (!("Notification" in window)) return null;
  if (requireHidden && typeof document !== "undefined" && !document.hidden) return null;
  const settings = await notificationSettings();
  if (!settings.enabled || Notification.permission !== "granted") return null;
  return settings;
}

/** Someone has asked to connect. Never fires for a request you sent. */
export async function notifyFriendRequest({ username }) {
  if (!(await canNotify())) return false;
  new Notification("New friend request", {
    body: `@${username ?? "someone"} wants to connect on Timber`,
    tag: `timber-friend-request:${username ?? "unknown"}`,
    icon: "/icons/timber-192.png",
    badge: "/icons/timber-192.png",
  });
  return true;
}

/** A request you sent was accepted, so a private chat now exists. */
export async function notifyFriendAccepted({ username }) {
  if (!(await canNotify())) return false;
  new Notification("Friend request accepted", {
    body: `@${username ?? "someone"} accepted. You can start a private chat.`,
    tag: `timber-friend-accepted:${username ?? "unknown"}`,
    icon: "/icons/timber-192.png",
    badge: "/icons/timber-192.png",
  });
  return true;
}

/**
 * An incoming call while Timber is in the background.
 *
 * `requireInteraction` keeps it on screen rather than auto-dismissing after a
 * few seconds: a call is worth nothing if the alert disappears before the
 * person reaches their device. The equivalent for a fully closed app is the
 * service worker's push handler.
 */
export async function notifyIncomingCall({ username, mode }) {
  if (!(await canNotify())) return false;
  new Notification(`@${username ?? "A friend"} is calling`, {
    body: `Incoming Timber ${mode === "video" ? "video" : "audio"} call`,
    tag: "timber-call",
    renotify: true,
    requireInteraction: true,
    icon: "/icons/timber-192.png",
    badge: "/icons/timber-192.png",
  });
  return true;
}

export async function notifyIncoming({ conversationId, username, message, isActive, mine }) {
  if (mine || isActive || message?.payload?.quiet || !("Notification" in window)) return;
  const settings = await notificationSettings();
  if (!settings.enabled || Notification.permission !== "granted" || settings.chats?.[conversationId] === "muted") return;
  if (settings.digest) {
    const digest = (await getMeta(DIGEST_KEY)) ?? {};
    await setMeta(DIGEST_KEY, { ...digest, [conversationId]: (digest[conversationId] ?? 0) + 1 });
    return;
  }
  new Notification("Timber", {
    body: `New private message from @${username ?? "a contact"}`,
    tag: `timber:${conversationId}`,
    renotify: false,
  });
}

export async function pendingDigestCount() {
  return Object.values((await getMeta(DIGEST_KEY)) ?? {}).reduce((total, value) => total + value, 0);
}

export async function clearDigest() {
  await setMeta(DIGEST_KEY, {});
}

/** A generic, opt-in nudge. It never reveals a contact or message. */
export async function maybeShowCheckIn() {
  if (!("Notification" in window)) return false;
  const settings = await notificationSettings();
  if (!settings.enabled || !settings.checkIns || Notification.permission !== "granted") return false;
  const last = await getMeta(CHECK_IN_KEY);
  if (last?.at && Date.now() - last.at < 3 * 24 * 60 * 60 * 1000) return false;
  new Notification("Timber", { body: "A gentle reminder to check in with someone you care about.", tag: "timber-check-in" });
  await setMeta(CHECK_IN_KEY, { at: Date.now() });
  return true;
}
