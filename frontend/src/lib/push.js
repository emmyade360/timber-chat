// Opt-in background call alerts. The browser owns the subscription keys; Timber
// stores only the public delivery subscription and never requests permission by itself.

import { removePushSubscription, savePushSubscription } from './api.js';

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

export async function enableCallAlerts() {
  const publicKey = import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY?.trim();
  if (!pushSupported() || !publicKey) throw new Error('Incoming call alerts are not available in this browser yet.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Call alerts were not allowed by this browser.');
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(publicKey) });
  await savePushSubscription(subscription.toJSON());
  return subscription;
}

export async function disableCallAlerts() {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await removePushSubscription(subscription.endpoint).catch(() => {});
  await subscription.unsubscribe();
}

export async function callAlertsEnabled() {
  if (!pushSupported()) return false;
  const registration = await navigator.serviceWorker.ready;
  return Boolean(await registration.pushManager.getSubscription());
}
