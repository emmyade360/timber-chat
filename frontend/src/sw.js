// PWA shell only: API responses, attachments, sessions, and websocket traffic
// are deliberately absent from the precache.
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Take over immediately rather than waiting for every tab to close. Without
// this an installed PWA can keep serving an old worker for weeks, which means
// a fix to the push handling below would simply never reach the people who
// need it.
self.skipWaiting();
clientsClaim();

/**
 * Alerts for a device whose app is fully closed.
 *
 * Every payload here is a type and a username -- never anything from a
 * conversation. A call is the one that has to interrupt; the friend events are
 * ordinary notifications that can wait to be noticed.
 */
function notificationFor(data) {
  if (data.type === 'incoming-call') {
    if (!data.username) return null;
    const mode = data.media === 'video' ? 'video' : 'audio';
    return [`@${data.username} is calling`, {
      body: `Incoming Timber ${mode} call`,
      tag: `timber-call:${data.callId ?? 'incoming'}`,
      renotify: true,
      requireInteraction: true,
    }];
  }
  if (data.type === 'friend-request') {
    if (!data.username) return null;
    return [`New friend request`, {
      body: `@${data.username} wants to connect on Timber`,
      tag: `timber-friend-request:${data.username}`,
    }];
  }
  if (data.type === 'friend-accepted') {
    if (!data.username) return null;
    return [`Friend request accepted`, {
      body: `@${data.username} accepted. You can start a private chat.`,
      tag: `timber-friend-accepted:${data.username}`,
    }];
  }
  if (data.type === 'message') {
    // Deliberately says nothing about the message. The relay cannot read it,
    // and the push service should learn no more than the relay does.
    return [`Timber`, {
      body: `New private message from @${data.username ?? 'a contact'}`,
      // Keyed to the conversation so a thread collapses to one entry rather
      // than stacking. `renotify` must stay true: replacing a notification
      // without it is silent, so only the first message in a thread ever
      // alerted and the rest arrived with no sound at all.
      tag: `timber-chat:${data.conversationId ?? 'unknown'}`,
      renotify: true,
    }];
  }
  return null;
}

/** Where tapping a notification should land. */
function targetFor(data) {
  if (data.type === 'incoming-call') {
    return { kind: 'call', callId: data.callId ?? null, conversationId: data.conversationId ?? null };
  }
  if (data.type === 'message') {
    return { kind: 'chat', conversationId: data.conversationId ?? null };
  }
  return { kind: 'people' };
}

/**
 * The fallback notification.
 *
 * A push subscription is `userVisibleOnly`, so showing nothing is a promise
 * broken: browsers surface their own "this site was updated in the background"
 * and, after repeated offences, revoke the subscription outright -- which would
 * end notifications on that device permanently and silently. A payload we
 * cannot classify still has to put something on screen.
 */
const GENERIC = ['Timber', {
  body: 'Something is waiting for you in Timber.',
  tag: 'timber-generic',
}];

/** The cold-start form of the same target, as query parameters. */
function urlFor(target) {
  if (target.kind === 'chat' && target.conversationId) {
    return `/?c=${encodeURIComponent(target.conversationId)}`;
  }
  if (target.kind === 'call') {
    return target.conversationId ? `/?call=1&c=${encodeURIComponent(target.conversationId)}` : '/?call=1';
  }
  if (target.kind === 'people') return '/?people=1';
  return '/';
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { /* malformed push is ignored */ }
  const [title, options] = notificationFor(data) ?? GENERIC;
  event.waitUntil(self.registration.showNotification(title, {
    icon: '/icons/timber-192.png',
    badge: '/icons/timber-192.png',
    ...options,
    // The ids have to survive onto the notification itself: without them the
    // click handler has no idea which conversation or call it belongs to, which
    // is why every tap used to land on the home screen.
    data: {
      type: data.type,
      conversationId: data.conversationId ?? null,
      callId: data.callId ?? null,
      username: data.username ?? null,
    },
  }).catch(() => {
    // A revoked permission or an OS-level notification failure must not leave
    // the push event rejected; the provider can then continue future delivery.
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = targetFor(event.notification.data ?? {});
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      // A running tab cannot be navigated without losing its unlocked session,
      // so hand it the target and let it route itself.
      existing.postMessage({ type: 'timber-open', target });
      return existing.focus();
    }
    return self.clients.openWindow(urlFor(target));
  })().catch(() => {
    // The window may disappear between matchAll and focus/openWindow.
  }));
});

/**
 * Push services rotate endpoints, and until now that silently ended a device's
 * notifications for good.
 *
 * The worker cannot re-register with the relay itself: the session token lives
 * only in the page's memory. So it re-subscribes and parks the result where the
 * page can find it and upload it on next launch.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;
    if (!applicationServerKey) return;
    try {
      const next = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      const cache = await caches.open('timber-push');
      await cache.put('/__push-handover', new Response(JSON.stringify({
        subscription: next.toJSON(),
        oldEndpoint: event.oldSubscription?.endpoint ?? null,
      })));
    } catch {
      // Nothing useful to do here; the page re-checks its subscription on start.
    }
  })());
});
