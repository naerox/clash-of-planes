// Failure-gallery switches (README, Lab 3). Each `?fail=` value breaks one thing on the
// FIRST boot only, so pressing Retry shows the recovery path, not the same failure again.
//
//   ?fail=404            sprite sheet URL → missing file (404, optional → vector fallback)
//   ?fail=json           config/game.json → truncated copy (ParseError, required → Retry)
//   ?fail=timeout        config/game.json answers after 10 s; per-request timeout → Retry
//   ?fail=abort          assets slowed to 1.5 s, loading aborted 400 ms in (same as Esc)
//   ?fail=flaky          every asset answers 503 once, then succeeds (retry + backoff)
//   ?fail=rooms-timeout  first two GET /api/rooms time out, then the lobby recovers
//   ?latency=ms          every asset request is delayed by `ms` (server side)

export function readFaults(search = window.location.search) {
  const q = new URLSearchParams(search);
  return {
    fail: q.get("fail") ?? "",
    latency: Number(q.get("latency")) || 0,
  };
}

function withQuery(url, params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  if (!entries.length) return url;
  const qs = new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
  return `${url}${url.includes("?") ? "&" : "?"}${qs}`;
}

/** Returns a rewritten copy of the manifest for this boot attempt. */
export function applyFaults(manifest, { fail, latency }, { firstBoot, bootId }) {
  const active = firstBoot ? fail : "";
  const assets = manifest.assets.map((a) => {
    let url = a.url;
    const params = { delay: latency || undefined };
    if (active === "404" && a.id === "sheet") url = "sprites/missing.png";
    if (active === "json" && a.id === "config") url = "config/game.broken.json";
    if (active === "timeout" && a.id === "config") params.delay = 10_000;
    if (active === "flaky") Object.assign(params, { status: 503, times: 1, key: bootId });
    // Local files arrive in a few ms; slow them down so the abort lands mid-download.
    if (active === "abort") params.delay = Math.max(latency, 1500);
    return { ...a, url: withQuery(url, params) };
  });
  return { ...manifest, assets };
}

export function lobbyUrl(baseUrl, { fail, latency }, { bootId }) {
  if (fail === "rooms-timeout") return withQuery(baseUrl, { delay: 6000, times: 2, key: bootId });
  return withQuery(baseUrl, { delay: latency || undefined });
}

export function abortAfterMs({ fail }, { firstBoot }) {
  return firstBoot && fail === "abort" ? 400 : 0;
}
