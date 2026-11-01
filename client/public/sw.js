// A deliberately small service worker. Its only jobs: make the game INSTALLABLE (Chrome and
// Safari want one) and make the second visit start faster by keeping the static files.
//
// What it does NOT do: it never touches /api, /ws, /health, /ready or /metrics (live data must be
// live), and it does not make the game work offline — a multiplayer game without its server has
// nothing to show. When the network is down, the page it kept loads and the game says "server
// unavailable", which is the honest outcome.
//
//   navigations  network first (a new deploy shows up at once), the cached page if the network is down
//   other files  stale-while-revalidate: answer from the cache, refresh it in the background
//
// Bump CACHE to throw everything away.

const CACHE = "dogfight-static-v1";
const LIVE = ["/api/", "/ws", "/health", "/ready", "/metrics"];

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (LIVE.some((p) => url.pathname === p || url.pathname.startsWith(p))) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((c) => c.put("/", copy));
          return response;
        })
        .catch(async () => (await caches.match("/")) ?? Response.error()),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      const refresh = fetch(request)
        .then((response) => {
          if (response.ok) void cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? refresh;
    })(),
  );
});
