const state = {
  firebaseConfig: null,
  auth: null,
  messaging: null,
  serviceWorkerRegistration: null,
  currentUser: null,
  idToken: null,
  concerts: [],
  tickets: [],
  deferredInstallPrompt: null
};

const elements = {
  alert: document.querySelector("#alert"),
  connectionStatus: document.querySelector("#connectionStatus"),
  installButton: document.querySelector("#installButton"),
  signInButton: document.querySelector("#signInButton"),
  signOutButton: document.querySelector("#signOutButton"),
  refreshButton: document.querySelector("#refreshButton"),
  reserveForm: document.querySelector("#reserveForm"),
  reserveButton: document.querySelector("#reserveButton"),
  notificationButton: document.querySelector("#notificationButton"),
  concertsList: document.querySelector("#concertsList"),
  ticketsList: document.querySelector("#ticketsList"),
  concertSelect: document.querySelector("#concertSelect"),
  categoryInput: document.querySelector("#categoryInput"),
  quantityInput: document.querySelector("#quantityInput")
};

function showAlert(message, type = "info") {
  elements.alert.textContent = message;
  elements.alert.classList.toggle("error", type === "error");
  elements.alert.hidden = false;
}

function clearAlert() {
  elements.alert.hidden = true;
}

function setBusy(button, busyText, isBusy) {
  if (!button) {
    return;
  }

  if (isBusy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function cacheValue(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function readCachedValue(key, fallback) {
  const value = localStorage.getItem(key);
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function loadScript(src) {
  if (document.querySelector(`script[src="${src}"]`)) {
    return;
  }

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function loadFirebaseSdk() {
  await loadScript("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
  await loadScript("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js");
  await loadScript("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");
}

function hasFirebaseConfig(config) {
  return Boolean(
    config?.apiKey &&
      config?.authDomain &&
      config?.projectId &&
      config?.messagingSenderId &&
      config?.appId
  );
}

async function apiFetch(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (state.idToken) {
    headers.Authorization = `Bearer ${state.idToken}`;
  }

  const response = await fetch(path, {
    ...options,
    headers
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed with ${response.status}`);
  }

  return response.json();
}

function renderConcerts() {
  elements.concertSelect.innerHTML = "";

  if (state.concerts.length === 0) {
    elements.concertsList.innerHTML =
      '<div class="empty-state">No concerts loaded yet. Refresh while online to cache the latest list.</div>';
    return;
  }

  elements.concertsList.innerHTML = state.concerts
    .map(
      (concert) => `
        <section class="data-row">
          <div class="data-row-header">
            <div>
              <p class="data-title">${concert.name}</p>
              <p class="data-meta">${concert.venue} - ${new Date(concert.startsAt).toLocaleString()}</p>
            </div>
            <span class="stock-pill">${concert.availableStock}/${concert.totalStock} left</span>
          </div>
        </section>
      `
    )
    .join("");

  for (const concert of state.concerts) {
    const option = document.createElement("option");
    option.value = String(concert.id);
    option.textContent = `${concert.name} (${concert.availableStock} left)`;
    option.disabled = concert.availableStock <= 0;
    elements.concertSelect.appendChild(option);
  }
}

function renderTickets() {
  if (!state.currentUser) {
    elements.ticketsList.innerHTML =
      '<div class="empty-state">Sign in to see only the tickets owned by your Google account.</div>';
    return;
  }

  if (state.tickets.length === 0) {
    elements.ticketsList.innerHTML =
      '<div class="empty-state">No tickets yet. Reserve a concert above to create your first hold.</div>';
    return;
  }

  elements.ticketsList.innerHTML = state.tickets
    .map((ticket) => {
      const expiresAt = ticket.expiresAt
        ? `Expires ${new Date(ticket.expiresAt).toLocaleTimeString()}`
        : "No active expiry";
      const purchaseButton =
        ticket.status === "PENDING" && navigator.onLine
          ? `<button class="ghost-button" data-purchase-ticket="${ticket.id}" type="button">Purchase</button>`
          : "";

      return `
        <section class="data-row">
          <div class="data-row-header">
            <div>
              <p class="data-title">Ticket ${ticket.id} - ${ticket.category}</p>
              <p class="data-meta">Concert ${ticket.concertId} - Qty ${ticket.quantity} - ${expiresAt}</p>
            </div>
            <span class="stock-pill">${ticket.status}</span>
          </div>
          ${purchaseButton}
        </section>
      `;
    })
    .join("");
}

function updateOnlineState() {
  const online = navigator.onLine;
  elements.connectionStatus.textContent = online ? "Online" : "Offline browsing";
  elements.connectionStatus.classList.toggle("offline", !online);
  elements.reserveButton.disabled = !online || !state.currentUser;
  elements.notificationButton.disabled = !online || !state.currentUser;
  elements.refreshButton.disabled = !online;

  if (!online) {
    showAlert("You are offline. Cached concerts and tickets are available, but reserve and purchase actions are disabled.");
  }

  renderTickets();
}

async function refreshConcerts() {
  const concerts = await apiFetch("/api/v1/concerts", { method: "GET" });
  state.concerts = concerts;
  cacheValue("ticket-pwa:concerts", concerts);
  renderConcerts();
}

async function refreshTickets() {
  if (!state.currentUser || !state.idToken) {
    state.tickets = readCachedValue("ticket-pwa:tickets", []);
    renderTickets();
    return;
  }

  const tickets = await apiFetch("/api/v1/me/tickets", { method: "GET" });
  state.tickets = tickets;
  cacheValue("ticket-pwa:tickets", tickets);
  renderTickets();
}

async function refreshDashboard() {
  clearAlert();
  try {
    await refreshConcerts();
    await refreshTickets();
  } catch (error) {
    state.concerts = readCachedValue("ticket-pwa:concerts", []);
    state.tickets = readCachedValue("ticket-pwa:tickets", []);
    renderConcerts();
    renderTickets();
    showAlert(error.message, "error");
  }
}

async function initializeServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  state.serviceWorkerRegistration = await navigator.serviceWorker.register("/app/sw.js", {
    scope: "/app/"
  });
}

async function initializeFirebase() {
  if (!navigator.onLine) {
    return;
  }

  state.firebaseConfig = await apiFetch("/api/v1/firebase-config", { method: "GET" });

  if (!hasFirebaseConfig(state.firebaseConfig)) {
    showAlert("Firebase public config is missing. Add the FIREBASE_* web values to .env before testing sign-in.", "error");
    return;
  }

  await loadFirebaseSdk();

  if (!firebase.apps.length) {
    firebase.initializeApp(state.firebaseConfig);
  }

  state.auth = firebase.auth();
  state.messaging = firebase.messaging.isSupported()
    ? firebase.messaging()
    : null;

  state.auth.onAuthStateChanged(async (user) => {
    state.currentUser = user;
    state.idToken = user ? await user.getIdToken() : null;
    elements.signInButton.hidden = Boolean(user);
    elements.signOutButton.hidden = !user;
    updateOnlineState();
    await refreshTickets();
  });
}

async function signIn() {
  if (!state.auth) {
    showAlert("Firebase Auth is not ready yet.", "error");
    return;
  }

  const provider = new firebase.auth.GoogleAuthProvider();
  await state.auth.signInWithPopup(provider);
}

async function signOut() {
  if (state.auth) {
    await state.auth.signOut();
  }
}

async function reserveTickets(event) {
  event.preventDefault();

  if (!state.currentUser) {
    showAlert("Sign in before reserving tickets.", "error");
    return;
  }

  if (!navigator.onLine) {
    showAlert("Reservation is disabled while offline.", "error");
    return;
  }

  setBusy(elements.reserveButton, "Reserving", true);

  try {
    await apiFetch("/api/v1/reserve", {
      method: "POST",
      body: JSON.stringify({
        concertId: Number(elements.concertSelect.value),
        category: elements.categoryInput.value || "General",
        quantity: Number(elements.quantityInput.value)
      })
    });
    showAlert("Reservation created. You will be warned before it expires.");
    await refreshDashboard();
  } catch (error) {
    showAlert(error.message, "error");
  } finally {
    setBusy(elements.reserveButton, "Reserve tickets", false);
    updateOnlineState();
  }
}

async function purchaseTicket(ticketId) {
  if (!navigator.onLine) {
    showAlert("Purchase is disabled while offline.", "error");
    return;
  }

  try {
    await apiFetch("/api/v1/purchase", {
      method: "POST",
      body: JSON.stringify({ ticketId })
    });
    showAlert(`Ticket ${ticketId} purchased.`);
    await refreshDashboard();
  } catch (error) {
    showAlert(error.message, "error");
  }
}

async function enableNotifications() {
  if (!state.currentUser || !state.idToken) {
    showAlert("Sign in before enabling reminders.", "error");
    return;
  }

  if (!state.messaging || !state.firebaseConfig?.vapidKey) {
    showAlert("Firebase Messaging or FIREBASE_VAPID_KEY is not configured.", "error");
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    showAlert("Notification permission was not granted.", "error");
    return;
  }

  const token = await state.messaging.getToken({
    vapidKey: state.firebaseConfig.vapidKey,
    serviceWorkerRegistration: state.serviceWorkerRegistration
  });

  await apiFetch("/api/v1/me/fcm-tokens", {
    method: "POST",
    body: JSON.stringify({ token })
  });

  showAlert("This browser is registered for reservation expiry reminders.");
}

function wireEvents() {
  elements.signInButton.addEventListener("click", () => signIn().catch((error) => showAlert(error.message, "error")));
  elements.signOutButton.addEventListener("click", () => signOut().catch((error) => showAlert(error.message, "error")));
  elements.refreshButton.addEventListener("click", () => refreshDashboard());
  elements.reserveForm.addEventListener("submit", reserveTickets);
  elements.notificationButton.addEventListener("click", () => enableNotifications().catch((error) => showAlert(error.message, "error")));
  elements.ticketsList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-purchase-ticket]");
    if (button) {
      purchaseTicket(Number(button.dataset.purchaseTicket));
    }
  });

  window.addEventListener("online", () => {
    clearAlert();
    updateOnlineState();
    refreshDashboard();
  });
  window.addEventListener("offline", updateOnlineState);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    elements.installButton.hidden = false;
  });

  elements.installButton.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) {
      return;
    }

    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    elements.installButton.hidden = true;
  });
}

async function boot() {
  wireEvents();
  state.concerts = readCachedValue("ticket-pwa:concerts", []);
  state.tickets = readCachedValue("ticket-pwa:tickets", []);
  renderConcerts();
  renderTickets();
  updateOnlineState();

  await initializeServiceWorker();
  await initializeFirebase();
  await refreshDashboard();
}

boot().catch((error) => {
  showAlert(error.message, "error");
});
