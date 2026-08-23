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
