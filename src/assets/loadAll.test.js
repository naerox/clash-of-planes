import test from "node:test";
import assert from "node:assert/strict";
import { loadAll, loadSequential } from "./loadAll.js";
import { HttpError } from "../net/http.js";
import { sleep } from "../async.js";

const manifest = {
  assets: [
    { id: "config", type: "json", url: "config.json", size: 100 },
    { id: "sheet", type: "image", url: "sheet.png", optional: true, size: 1000 },
    { id: "sfx", type: "audio", url: "fire.wav", optional: true, size: 500 },
  ],
};

/** Fake loaders: each waits `ms` (abortably), reports bytes, then resolves or throws. */
function fakeLoaders({ ms = 30, fail = {} } = {}) {
  const started = [];
  const make =
    (type) =>
    async (url, { signal, onBytes }) => {
      started.push({ url, at: performance.now() });
      await sleep(ms, signal);
      if (fail[url]) throw fail[url];
      onBytes(1, 1);
      return `${type}:${url}`;
    };
  return { loaders: { json: make("json"), image: make("image"), audio: make("audio") }, started };
}

test("loadAll starts every file at once and resolves a Map by id", async () => {
  const { loaders, started } = fakeLoaders({ ms: 40 });
  const t0 = performance.now();
  const { assets, failures } = await loadAll(manifest, { loaders });
  const elapsed = performance.now() - t0;
  assert.equal(assets.get("sheet"), "image:sheet.png");
  assert.equal(failures.length, 0);
  assert.ok(elapsed < 100, `concurrent: ~40 ms, not 3×40 (got ${elapsed.toFixed(0)})`);
  assert.ok(started.at(-1).at - started[0].at < 10, "all started together");
});

test("loadSequential does the same work one file after another", async () => {
  const { loaders } = fakeLoaders({ ms: 40 });
  const t0 = performance.now();
  await loadSequential(manifest, { loaders });
  assert.ok(performance.now() - t0 >= 115, "≈ 3 × 40 ms");
});

test("progress: per-file statuses and a fraction that ends at 1", async () => {
  const { loaders } = fakeLoaders();
  const snaps = [];
  await loadAll(manifest, { loaders, onProgress: (s) => snaps.push(structuredClone(s)) });
  const last = snaps.at(-1);
  assert.equal(last.fraction, 1);
  assert.equal(last.finished, 3);
  assert.ok(last.files.every((f) => f.status === "done"));
  assert.ok(snaps.some((s) => s.files.some((f) => f.status === "loading")));
});

test("an optional asset that 404s resolves to null and is listed in failures", async () => {
  const { loaders } = fakeLoaders({ fail: { "sheet.png": new HttpError("sheet.png", 404) } });
  const { assets, failures } = await loadAll(manifest, { loaders });
  assert.equal(assets.get("sheet"), null);
  assert.equal(assets.get("config"), "json:config.json");
  assert.deepEqual(
    failures.map((f) => f.id),
    ["sheet"],
  );
});

test("a required failure rejects Promise.all and aborts the siblings still loading", async () => {
  const aborted = [];
  const loaders = {
    json: async () => {
      await sleep(10);
      throw new SyntaxError("broken");
    },
    image: async (url, { signal }) => {
      signal.addEventListener("abort", () => aborted.push(url));
      await sleep(1000, signal);
    },
    audio: async (url, { signal }) => {
      signal.addEventListener("abort", () => aborted.push(url));
      await sleep(1000, signal);
    },
  };
  const t0 = performance.now();
  await assert.rejects(loadAll(manifest, { loaders }), SyntaxError);
  assert.ok(performance.now() - t0 < 200, "fails fast, does not wait 1 s");
  assert.deepEqual(aborted.sort(), ["fire.wav", "sheet.png"]);
});

test("a caller abort rejects with AbortError even though most assets are optional", async () => {
  const { loaders } = fakeLoaders({ ms: 500 });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(loadAll(manifest, { loaders, signal: ac.signal }), { name: "AbortError" });
});

test("an unknown asset type is a required-asset error", async () => {
  const { loaders } = fakeLoaders();
  await assert.rejects(
    loadAll({ assets: [{ id: "x", type: "video", url: "x.mp4" }] }, { loaders }),
    /Невідомий тип/,
  );
});
