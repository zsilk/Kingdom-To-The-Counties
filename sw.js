/* K2C Ambassador Companion — service worker (v29 · app v1.7.0)
 Strategy: NETWORK-FIRST for everything, cache as fallback.
 When online, behavior is byte-for-byte identical to having no SW —
 fresh code always wins, so a deploy can never be masked by stale cache.
 When the field signal drops, the last good copy of the shell, fonts,
 images and starter scripts keeps loading. API calls (/.netlify/*) are
 never intercepted: live sync simply fails over to demo/offline handling. */
var CACHE = "k2c-v29";
var PRECACHE = [
 "./",
 "index.html",
 "manifest.webmanifest",
 "favicon.svg",
 "icon-192.png",
 "apple-touch-icon.png",
 "data/scripts.json",
 "data/setlists-default.json",
 "assets/qrcode.min.js",
 "assets/fonts/fraunces.woff2",
 "assets/fonts/fraunces-italic.woff2",
 "assets/share-graphic-1.png"
];

self.addEventListener("install", function (e) {
 e.waitUntil(
 caches.open(CACHE).then(function (c) {
 // Best-effort precache; individual failures don't block install.
 return Promise.allSettled(PRECACHE.map(function (u) { return c.add(u); }));
 }).then(function () { return self.skipWaiting(); })
 );
});

self.addEventListener("activate", function (e) {
 e.waitUntil(
 caches.keys().then(function (keys) {
 return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
 }).then(function () { return self.clients.claim(); })
 );
});

self.addEventListener("fetch", function (e) {
 var url = new URL(e.request.url);
 if (e.request.method !== "GET") return; // writes go straight through
 if (url.origin !== self.location.origin) return; // fonts CDN etc. untouched
 if (url.pathname.indexOf("/.netlify/") === 0) return; // live sync is never cached

 e.respondWith(
 fetch(e.request).then(function (res) {
 if (res && res.ok) {
 var copy = res.clone();
 caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
 }
 return res;
 }).catch(function () {
 return caches.match(e.request, { ignoreSearch: e.request.mode === "navigate" }).then(function (hit) {
 if (hit) return hit;
 if (e.request.mode === "navigate") return caches.match("index.html");
 return Response.error();
 });
 })
 );
});
