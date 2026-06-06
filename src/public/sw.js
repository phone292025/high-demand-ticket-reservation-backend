const CACHE_NAME = "ticket-hold-desk-v1";
const APP_SHELL = [
  "/app/",
  "/app/index.html",
  "/app/styles.css",
  "/app/app.js",
  "/app/manifest.webmanifest",
  "/app/icon.svg"
];
const DATA_CACHE = "ticket-hold-desk-data-v1";

async function configureFirebaseMessaging() {
  try {
    importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
    importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

    const response = await fetch("/api/v1/firebase-config");
    const config = await response.json();

    if (
      config.apiKey &&
      config.authDomain &&
      config.projectId &&
      config.messagingSenderId &&
      config.appId
    ) {
      firebase.initializeApp(config);
      const messaging = firebase.messaging();
      messaging.onBackgroundMessage((payload) => {
        const title = payload.notification?.title || "Reservation update";
        const body = payload.notification?.body || "Your ticket reservation changed.";
        self.registration.showNotification(title, {
          body,
          icon: "/app/icon.svg",
          badge: "/app/icon.svg",
          data: payload.data || {}
        });
      });
    }
  } catch {
    // The app shell must remain installable even when Firebase scripts are unavailable.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME && key !== DATA_CACHE)
            .map((key) => caches.delete(key))
        )
      )
  );
  self.clients.claim();
  event.waitUntil(configureFirebaseMessaging());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return;
  }

  if (url.pathname === "/api/v1/concerts" || url.pathname === "/api/v1/me/tickets") {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          const cache = await caches.open(DATA_CACHE);
          cache.put(request, response.clone());
          return response;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request);
          return (
            cachedResponse ||
            new Response("[]", {
              headers: { "Content-Type": "application/json" }
            })
          );
        })
    );
    return;
  }

  if (url.pathname.startsWith("/app/")) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        return (
          cachedResponse ||
          fetch(request).then(async (response) => {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
            return response;
          })
        );
      })
    );
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow("/app/"));
});
