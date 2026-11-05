// Added to the generated service worker (see vite.config.ts). Shows reminders
// sent by the server, and opens the app when one is tapped.

self.addEventListener('push', (event) => {
  const { title, body, tag, url } = event.data.json();
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      data: { url },
      icon: '/pwa-192.png',
      badge: '/pwa-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      if (open[0]) return open[0].focus();
      return self.clients.openWindow(event.notification.data?.url ?? '/');
    })(),
  );
});
