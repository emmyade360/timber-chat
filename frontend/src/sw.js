// PWA shell only: API responses, attachments, sessions, and websocket traffic
// are deliberately absent from the precache.
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { /* malformed push is ignored */ }
  if (data.type !== 'incoming-call' || !data.username) return;
  const mode = data.media === 'video' ? 'video' : 'audio';
  event.waitUntil(self.registration.showNotification(`@${data.username} is calling`, {
    body: `Incoming Timber ${mode} call`,
    tag: `timber-call:${data.callId ?? 'incoming'}`,
    renotify: true,
    requireInteraction: true,
    icon: '/icons/timber-192.png',
    badge: '/icons/timber-192.png',
    data: { type: 'incoming-call' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.focus();
    return self.clients.openWindow('/');
  })());
});
