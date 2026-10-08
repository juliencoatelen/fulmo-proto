/* Fulmo — hors connexion pour l'application de démonstration (getfulmo.com/app).

   Réseau d'abord, copie locale en secours : en ligne, on sert toujours la
   dernière version publiée ; dans une cave sans réseau, la page, ses scripts
   et l'inventaire (stocké dans le navigateur) restent disponibles. Seules les
   requêtes vers ce site passent par ici : rien d'autre n'est intercepté. */
"use strict";

var CACHE = "fulmo-app-v1";
var SHELL = [
  "/app",
  "/assets/css/tokens.css", "/assets/css/app.css", "/assets/css/onboarding.css", "/assets/css/tour.css", "/assets/css/consent.css",
  "/assets/js/sprite.js", "/assets/js/pano-capture.js", "/assets/js/pano-view.js", "/assets/js/app.js", "/assets/js/consent.js",
  "/assets/fonts/geist-latin-wght-normal.woff2", "/assets/fonts/geist-mono-latin-wght-normal.woff2", "/assets/fonts/bricolage-grotesque-latin-opsz-normal.woff2",
  "/favicon.svg", "/site.webmanifest"
];

self.addEventListener("install", function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    // Un fichier manquant ne doit pas empêcher l'installation du reste.
    return Promise.all(SHELL.map(function (url) { return cache.add(url).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("fulmo-app-") === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(fetch(request).then(function (response) {
    if (response.ok && response.type === "basic") {
      var copy = response.clone();
      caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
    }
    return response;
  }).catch(function () {
    return caches.match(request, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      if (request.mode === "navigate") return caches.match("/app");
      return Response.error();
    });
  }));
});
