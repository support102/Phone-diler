// Service Worker for Phone Dial Relay
// Handles Web Push notifications (works when browser is in background / screen off)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Handle incoming push notifications from server
self.addEventListener('push', (event) => {
  let data = { title: 'Dial Request', body: 'Incoming call request', phoneNumber: '' };

  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {}
  }

  const options = {
    body: data.body,
    icon: '/call.png',
    tag: 'dial-request', // Fixed tag so multiple requests from same session replace each other
    requireInteraction: true,
    vibrate: [300, 100, 300],
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
  // Open the website with the dial popup — user taps "Call Now" on the popup
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // If mobile.html is already open, focus it and send message
      for (const client of clients) {
        if (client.url.includes('mobile.html')) {
          client.postMessage({ type: 'trigger-call', phoneNumber });
          return client.focus();
        }
      }
      // Otherwise open a new window
      return self.clients.openWindow(`/mobile.html?dial=${phoneNumber}`);
    })
  );
});
