// Service Worker for Phone Dial Relay
// Handles Web Push notifications (works when browser is in background / screen off)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Handle incoming push notifications from server
self.addEventListener('push', (event) => {
  let data = { title: 'Dial Request', body: 'Incoming call request', phoneNumber: '' };
  try {
    data = event.data.json();
  } catch (e) {}

  const options = {
    body: data.body,
    tag: 'dial-request-' + Date.now(),
    requireInteraction: true,
    vibrate: [300, 100, 300, 100, 300],
    data: { phoneNumber: data.phoneNumber },
    actions: [
      { action: 'call', title: 'Call Now' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  const phoneNumber = event.notification.data.phoneNumber;
  event.notification.close();

  if (event.action === 'dismiss') return;

  // action === 'call' or user tapped the notification body
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Try to focus an existing mobile page
      for (const client of clients) {
        if (client.url.includes('mobile.html')) {
          client.focus();
          client.postMessage({ type: 'trigger-call', phoneNumber });
          return;
        }
      }
      // Fallback: open tel: directly
      return self.clients.openWindow(`tel:${phoneNumber}`);
    })
  );
});
