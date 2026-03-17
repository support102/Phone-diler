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
  // Try to open the phone dialer directly (works on many Android devices)
  event.waitUntil(
    self.clients.openWindow(`tel:${phoneNumber}`).catch(() => {
      // If tel: fails, fall back to opening the website with dial param
      return self.clients.openWindow(`/mobile.html?dial=${phoneNumber}`);
    })
  );
});
