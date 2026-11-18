// Gridlocked's service worker (M7 Task 14): Web Push and notification clicks
// only. It caches nothing and never answers a request, so the site works the
// same with or without it.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// The payload is always the spoiler-safe words (src/notifications/push.ts).
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "Gridlocked";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url || "/notifications" },
    }),
  );
});

// Opens the notification's page: an open tab of the site if there is one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || "/";
  const url = new URL(path, self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        for (const w of windows) {
          if (new URL(w.url).origin === url.origin && "navigate" in w) {
            return w.focus().then(() => w.navigate(url.href));
          }
        }
        return self.clients.openWindow(url.href);
      }),
  );
});
