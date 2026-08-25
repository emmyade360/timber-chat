// Opt-in background alerts for calls and messages.
//
// The browser owns the subscription keys; Timber stores only the public
// delivery subscription and never requests permission by itself. What the push
// provider is told is an event type, thread identifier, and sender username --
// never message content.

import { getMeta, setMeta } from '../db/localStore.js';
import { removePushSubscription, savePushSubscription } from './api.js';

const ENDPOINT_KEY = 'push-endpoint';
const SERVICE_WORKER_TIMEOUT_MS = 5000;

export const PUSH_STATUS = Object.freeze({
  unsupported: 'unsupported',
  missingKey: 'missing-public-key',
  denied: 'permission-denied',
  unavailable: 'service-worker-unavailable',
  notSubscribed: 'not-subscribed',
  ready: 'ready',
});

function publicKeyBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function pushSupported() {
  return typeof window !== 'undefined'
    && typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export function pushPublicKeyConfigured() {
  return Boolean(import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY?.trim());
}

function timeoutError() {
  return new Error('The notification service worker is not ready yet. Try again in a moment.');
}

/** Resolve the worker with a bound so a missing registration cannot hang UI. */
export async function serviceWorkerRegistration({ timeoutMs = SERVICE_WORKER_TIMEOUT_MS } = {}) {
  if (!pushSupported()) throw new Error('This browser does not support background notifications.');
  let timer;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A safe, user-facing readiness snapshot for Settings and setup prompts. */
export async function pushReadiness() {
  if (!pushSupported()) return { status: PUSH_STATUS.unsupported, endpoint: null };
  if (!pushPublicKeyConfigured()) return { status: PUSH_STATUS.missingKey, endpoint: null };
  if (Notification.permission === 'denied') return { status: PUSH_STATUS.denied, endpoint: null };
  try {
    const registration = await serviceWorkerRegistration();
    const subscription = await registration.pushManager.getSubscription();
    return subscription
      ? { status: PUSH_STATUS.ready, endpoint: subscription.endpoint }
      : { status: PUSH_STATUS.notSubscribed, endpoint: null };
  } catch {
    return { status: PUSH_STATUS.unavailable, endpoint: null };
  }
}

/** Register or reuse this browser's one subscription for the current account. */
export async function enablePushAlerts({ requestPermission = false } = {}) {
  const publicKey = import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY?.trim();
  if (!pushSupported() || !publicKey) throw new Error('Background alerts are not configured for this browser yet.');
  if (Notification.permission !== 'granted') {
    if (!requestPermission) throw new Error('Notifications were not allowed by this browser.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notifications were not allowed by this browser.');
  }
  const registration = await serviceWorkerRegistration();
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: publicKeyBytes(publicKey),
  });
  await savePushSubscription(subscription.toJSON());
  await setMeta(ENDPOINT_KEY, { endpoint: subscription.endpoint });
  return subscription;
}

/** Unsubscribe locally and remove the endpoint from the authenticated account. */
export async function disablePushAlerts() {
  const known = await getMeta(ENDPOINT_KEY).catch(() => null);
  let subscription = null;
  if (pushSupported()) {
    try {
      const registration = await serviceWorkerRegistration();
      subscription = await registration.pushManager.getSubscription();
    } catch {
      // A recorded endpoint can still be removed even if the worker is delayed.
    }
  }
  const endpoint = subscription?.endpoint ?? known?.endpoint;
  let serverRemoved = true;
  if (endpoint) {
    try {
      await removePushSubscription(endpoint);
    } catch {
      // Still disable this browser immediately. The provider will eventually
      // prune an unreachable endpoint, and the next enable reconciles it.
      serverRemoved = false;
    }
  }
  if (subscription) await subscription.unsubscribe().catch(() => {});
  await setMeta(ENDPOINT_KEY, null);
  return { serverRemoved };
}

export async function pushAlertsEnabled() {
  const readiness = await pushReadiness();
  return readiness.status === PUSH_STATUS.ready;
}

/**
 * Re-register a rotated service-worker endpoint after the page has a session.
 * The worker parks rotated credentials in Cache Storage because it cannot call
 * the authenticated API itself.
 */
export async function ensurePushSubscription() {
  if (!pushSupported() || !pushPublicKeyConfigured() || Notification.permission !== 'granted') return false;

  try {
    const cache = await caches.open('timber-push');
    const handover = await cache.match('/__push-handover');
    if (handover) {
      const { subscription, oldEndpoint } = await handover.json();
      if (subscription?.endpoint) {
        await savePushSubscription(subscription);
        await setMeta(ENDPOINT_KEY, { endpoint: subscription.endpoint });
        if (oldEndpoint && oldEndpoint !== subscription.endpoint) await removePushSubscription(oldEndpoint).catch(() => {});
      }
      await cache.delete('/__push-handover');
      return Boolean(subscription?.endpoint);
    }
  } catch {
    // No Cache Storage, malformed handover, or an API failure: use the normal check.
  }

  let registration;
  try { registration = await serviceWorkerRegistration(); } catch { return false; }
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return false;

  const known = await getMeta(ENDPOINT_KEY);
  if (known?.endpoint === subscription.endpoint) return false;
  await savePushSubscription(subscription.toJSON());
  await setMeta(ENDPOINT_KEY, { endpoint: subscription.endpoint });
  if (known?.endpoint && known.endpoint !== subscription.endpoint) {
    await removePushSubscription(known.endpoint).catch(() => {});
  }
  return true;
}
