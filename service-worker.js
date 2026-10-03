"use strict";

const CACHE_NAME = "utang-list-v7";
const FIREBASE_SCRIPTS = [
  "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js",
  "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js"
];
const APP_BASE = new URL("./", self.registration.scope);
const APP_FILES = ["./", "./index.html", "./style.css", "./app.js", "./cloud.js", "./firebase-config.js", "./manifest.json", "./icon.svg", "./icon-192.png", "./icon-512.png", "./service-worker.js", ...FIREBASE_SCRIPTS]
  .map(path => path.startsWith("https://") ? path : new URL(path, APP_BASE).href);
const INDEX_URL = new URL("index.html", APP_BASE).href;

self.addEventListener("install", event => {
  const localFiles = APP_FILES.filter(path => !path.startsWith("https://"));
  const remoteFiles = APP_FILES.filter(path => path.startsWith("https://"));
  event.waitUntil(caches.open(CACHE_NAME)
    .then(cache => cache.addAll(localFiles).then(() => Promise.allSettled(remoteFiles.map(path => cache.add(path)))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("utang-list-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(new Request(event.request, { cache: "no-cache" })).then(response => {
    if (response.ok && (new URL(event.request.url).origin === self.location.origin || new URL(event.request.url).hostname === "www.gstatic.com")) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    if (event.request.mode === "navigate") return caches.match(INDEX_URL);
    return Response.error();
  }));
});