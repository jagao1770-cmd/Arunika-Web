/* ARUNIKA - Service Worker
 * 1) Cache tampilan aplikasi agar bisa dibuka tanpa internet.
 * 2) Kirim antrian data offline (IndexedDB "arunika-offline") di latar belakang saat internet kembali
 *    (Background Sync, didukung Chrome/Android; iPhone/Safari: antrian dikirim saat aplikasi dibuka).
 * Naikkan nomor VERSI setiap kali index.html diperbarui agar cache lama dibuang.
 */
const VERSI = "arunika-v1";
const CACHE_APP = VERSI + "-app";
const CACHE_LUAR = VERSI + "-luar";

const FILE_APP = [
  "./",
  "./index.html"
];

// Host pustaka/font yang aman di-cache. Permintaan ke Apps Script TIDAK pernah di-cache.
const HOST_LUAR = ["cdn.tailwindcss.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_APP);
    await Promise.all(FILE_APP.map((f) => cache.add(f).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const nama = await caches.keys();
    await Promise.all(nama.filter((n) => !n.startsWith(VERSI)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Data aplikasi (Google Apps Script) selalu langsung ke jaringan.
  if (url.hostname.endsWith("google.com") || url.hostname.endsWith("googleusercontent.com")) {
    if (!HOST_LUAR.includes(url.hostname)) return;
  }

  // Halaman utama: jaringan dulu (supaya versi baru cepat muncul), cadangan dari cache saat offline.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) (await caches.open(CACHE_APP)).put("./index.html", res.clone());
        return res;
      } catch {
        return (await caches.match("./index.html")) || (await caches.match("./")) || Response.error();
      }
    })());
    return;
  }

  // File sendiri : cache dulu, perbarui di belakang.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_APP);
      const lama = await cache.match(req);
      const baru = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
      return lama || (await baru) || Response.error();
    })());
    return;
  }

  // Pustaka & font dari CDN: cache dulu, perbarui di belakang.
  if (HOST_LUAR.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_LUAR);
      const lama = await cache.match(req);
      const baru = fetch(req).then((res) => { if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()); return res; }).catch(() => null);
      return lama || (await baru) || Response.error();
    })());
  }
});

/* ---------- Kirim antrian offline di latar belakang ---------- */
function bukaDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("arunika-offline", 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const mintaStore = (db, nama, mode, fn) => new Promise((resolve, reject) => {
  const t = db.transaction(nama, mode);
  const res = fn(t.objectStore(nama));
  t.oncomplete = () => resolve(res && res.result);
  t.onerror = () => reject(t.error);
});

async function kirimAntrian() {
  const db = await bukaDb();
  const meta = await mintaStore(db, "meta", "readonly", (s) => s.get("url"));
  const url = meta && meta.value;
  if (!url) return 0;
  const daftar = ((await mintaStore(db, "queue", "readonly", (s) => s.getAll())) || [])
    .sort((a, b) => a.createdAt - b.createdAt);

  let terkirim = 0;
  for (const item of daftar) {
    if (item.failed) continue;
    let json;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: item.action, data: item.data })
      });
      json = JSON.parse(await res.text());
    } catch {
      throw new Error("jaringan");           // gagal jaringan: biarkan browser mencoba lagi nanti
    }
    if (json && json.success === true) {
      await mintaStore(db, "queue", "readwrite", (s) => s.delete(item.id));
      terkirim += 1;
    } else if (json && json.success === false) {   // ditolak server: tandai gagal, jangan blokir yang lain
      await mintaStore(db, "queue", "readwrite", (s) => s.put({ ...item, failed: true, error: json.message || "Ditolak server" }));
    } else {
      throw new Error("respons");
    }
  }
  if (terkirim) {
    const klien = await self.clients.matchAll({ includeUncontrolled: true });
    klien.forEach((k) => k.postMessage({ type: "queue-flushed", sent: terkirim }));
  }
  return terkirim;
}

self.addEventListener("sync", (event) => {
  if (event.tag === "arunika-sync") event.waitUntil(kirimAntrian());
});
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "arunika-periodic") event.waitUntil(kirimAntrian().catch(() => {}));
});
