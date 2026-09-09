/**
 * Offline-Betrieb.
 *
 * Die großen unveränderlichen Dateien (Texterkennung, Sprachdaten) kommen aus
 * dem Cache. Der eigene Programmcode wird zuerst aus dem Netz geholt, damit
 * eine neue Version auf Strato sofort ankommt und nicht in alten Ständen hängt.
 */

const VERSION = "v3";
const SHELL = `terminplan-shell-${VERSION}`;
const VENDOR = "terminplan-vendor-v1";

const SHELL_FILES = [
  "./", "./index.html", "./styles.css",
  "./app.js", "./store.js", "./parser.js", "./ocr.js", "./ics.js",
  "./manifest.webmanifest", "./icon.svg",
];

const VENDOR_FILES = [
  "./vendor/tesseract.min.js", "./vendor/worker.min.js",
  "./vendor/tesseract-core-lstm.wasm.js", "./vendor/tesseract-core-simd-lstm.wasm.js",
  "./vendor/pdf.mjs", "./vendor/pdf.worker.mjs",
  "./tessdata/deu.traineddata.gz",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(SHELL_FILES);
    // Die Vendor-Dateien sind groß; ein Fehlschlag darf die Installation nicht kippen.
    const vendor = await caches.open(VENDOR);
    await Promise.allSettled(VENDOR_FILES.map((file) => vendor.add(file)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== SHELL && key !== VENDOR).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  const isVendor = /\/(vendor|tessdata)\//.test(request.url);
  event.respondWith(isVendor ? cacheFirst(request) : networkFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) (await caches.open(VENDOR)).put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(SHELL)).put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") return caches.match("./index.html");
    throw error;
  }
}
