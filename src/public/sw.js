/**
 * The build id below is stamped in by `npm run copy:public`. A hardcoded cache
 * name meant installed clients kept serving the old bundle forever, because
 * nothing ever invalidated the entry.
 */
const BUILD_ID = "__BUILD_ID__";
const CACHE_NAME = `ticket-hold-desk-${BUILD_ID}`;
const DATA_CACHE = `ticket-hold-desk-data-${BUILD_ID}`;
const APP_SHELL = [
  "/app/",
  "/app/index.html",
  "/app/styles.css",
  "/app/app.js",
  "/app/manifest.webmanifest",
  "/app/icon.svg"
];

async function configureFirebaseMessaging() {
  try {
    importScripts(
      "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js"
    );
    importScripts(
      "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js"
    );

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
        const body =
          payload.notification?.body || "Your ticket reservation changed.";
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
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
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
      .then(() => self.clients.claim())
      .then(() => configureFirebaseMessaging())
  );
});

/**
 * Serve the cached copy immediately, then refresh it in the background so the
 * next load picks up a new deploy. Falls back to the network on a cold cache.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);

  const networkFetch = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);

  return cachedResponse || (await networkFetch) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname === "/api/v1/concerts") {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response && response.ok) {
            const cache = await caches.open(DATA_CACHE);
            cache.put(request, response.clone());
          }
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

  if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
    event.respondWith(staleWhileRevalidate(request, CACHE_NAME));
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow("/app/"));
});
