// Opt-in background alerts for calls and messages.
//
// The browser owns the subscription keys; Timber stores only the public
// delivery subscription and never requests permission by itself. What the push
// provider is told is a type and a username -- never message content, which the
// relay could not read either.

import { getMeta, setMeta } from '../db/localStore.js';
import { removePushSubscription, savePushSubscription } from './api.js';

const ENDPOINT_KEY = 'push-endpoint';

function publicKeyBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function pushSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export async function enablePushAlerts() {
  const publicKey = import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY?.trim();
  if (!pushSupported() || !publicKey) throw new Error('Background alerts are not available in this browser yet.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed by this browser.');
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(publicKey) });
  await savePushSubscription(subscription.toJSON());
  await setMeta(ENDPOINT_KEY, { endpoint: subscription.endpoint });
  return subscription;
}

export async function disablePushAlerts() {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  await setMeta(ENDPOINT_KEY, null);
  if (!subscription) return;
  await removePushSubscription(subscription.endpoint).catch(() => {});
  await subscription.unsubscribe();
}

export async function pushAlertsEnabled() {
  if (!pushSupported()) return false;
  const registration = await navigator.serviceWorker.ready;
  return Boolean(await registration.pushManager.getSubscription());
}

/**
 * Keep this device's subscription registered with the relay.
 *
 * Push services rotate endpoints, and the service worker cannot re-register on
 * its own: the session token lives only in this page's memory. So the worker
 * parks any replacement it made in a cache entry, and this drains it.
 *
 * The re-POST is conditional on the endpoint having actually changed, because
 * the relay allows only eight subscription writes an hour and an unconditional
 * write on every launch would lock out anyone who reopens the app often.
 */
export async function ensurePushSubscription() {
  if (!pushSupported()) return false;

  // Anything the worker re-subscribed to while the page was closed.
  try {
    const cache = await caches.open('timber-push');
    const handover = await cache.match('/__push-handover');
    if (handover) {
      const { subscription, oldEndpoint } = await handover.json();
      if (oldEndpoint) await removePushSubscription(oldEndpoint).catch(() => {});
      if (subscription?.endpoint) {
        await savePushSubscription(subscription);
        await setMeta(ENDPOINT_KEY, { endpoint: subscription.endpoint });
      }
      await cache.delete('/__push-handover');
      return true;
    }
  } catch {
    // No Cache Storage, or nothing parked. Fall through to the normal check.
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return false;

  const known = await getMeta(ENDPOINT_KEY);
  if (known?.endpoint === subscription.endpoint) return false;

  await savePushSubscription(subscription.toJSON());
  await setMeta(ENDPOINT_KEY, { endpoint: subscription.endpoint });
  return true;
}
