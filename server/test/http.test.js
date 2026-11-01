import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRoom, startApp } from "./helpers.js";

/** Sends a raw request line, so nothing (fetch, URL) normalises `..` before the server sees it. */
function raw(port, target, extra = "") {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n${extra}\r\n`);
    });
    let data = "";
    socket.on("data", (c) => (data += c));
    socket.on("end", () => resolve({ status: Number(data.slice(9, 12)), text: data }));
    socket.on("error", reject);
  });
}

async function withSite(fn) {
  const s = await startApp();
  await mkdir(join(s.dir, "assets"), { recursive: true });
  await writeFile(join(s.dir, "index.html"), "<!doctype html><title>game</title>");
  await writeFile(join(s.dir, "assets", "index-BsnFg-_R.js"), "export {}");
  await writeFile(join(s.dir, "assets", "sheet.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(s.dir, "secret.txt"), "not for you"); // same dir here, but see traversal
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

test("GET /health", async () => {
  await withSite(async (s) => {
    const res = await fetch(`${s.base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(typeof body.rss, "number");
  });
});

test("static: index, correct MIME types, caching headers", async () => {
  await withSite(async (s) => {
    const root = await fetch(`${s.base}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type"), /^text\/html/);
    assert.equal(root.headers.get("cache-control"), "no-cache");
    assert.match(await root.text(), /<title>game/);

    const js = await fetch(`${s.base}/assets/index-BsnFg-_R.js`);
    assert.match(js.headers.get("content-type"), /^text\/javascript/);
    assert.match(js.headers.get("cache-control"), /immutable/);

    const png = await fetch(`${s.base}/assets/sheet.png`);
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.equal(png.headers.get("cache-control"), "no-cache", "unhashed assets are revalidated");
    assert.equal(png.headers.get("content-length"), "4");
  });
});

test("static: ETag → 304, HEAD has no body, missing file → 404, POST → 405", async () => {
  await withSite(async (s) => {
    const first = await fetch(`${s.base}/assets/sheet.png`);
    const etag = first.headers.get("etag");
    const again = await fetch(`${s.base}/assets/sheet.png`, { headers: { "If-None-Match": etag } });
    assert.equal(again.status, 304);
    const head = await fetch(`${s.base}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(`${s.base}/nope.js`)).status, 404);
    assert.equal((await fetch(`${s.base}/`, { method: "POST" })).status, 405);
  });
});

test("path traversal is rejected, in every spelling", async () => {
  await withSite(async (s) => {
    const attempts = [
      "/../package.json",
      "/assets/../../package.json",
      "/%2e%2e/package.json",
      "/%2E%2E%2Fpackage.json",
      "/assets/..%2f..%2fpackage.json",
      "/..%5cpackage.json",
      "/assets/%2e%2e/%2e%2e/etc/passwd",
      "/api/rooms/../../x",
    ];
    for (const target of attempts) {
      const r = await raw(s.port, target);
      assert.equal(r.status, 403, `${target} → ${r.status}`);
    }
    assert.equal((await raw(s.port, "/%00.html")).status, 400, "NUL byte");
    assert.equal((await raw(s.port, "/%E0%A4%A")).status, 400, "broken percent-encoding");
  });
});

test("a file merely *named* with dots is fine", async () => {
  await withSite(async (s) => {
    await writeFile(join(s.dir, "a..b.txt"), "ok");
    assert.equal((await fetch(`${s.base}/a..b.txt`)).status, 200);
  });
});

test("GET/POST /api/rooms", async () => {
  await withSite(async (s) => {
    let list = await (await fetch(`${s.base}/api/rooms`)).json();
    assert.deepEqual(list, { rooms: [] });

    const made = await createRoom(s.base, {
      name: "Пояс астероїдів",
      arena: { asteroids: 8, hunters: 1, asteroidSpeed: [50, 120] },
      maxPlayers: 4,
    });
    assert.equal(made.status, 201);
    assert.equal(made.body.players, 0);
    assert.equal(made.body.maxPlayers, 4);
    assert.deepEqual(made.body.arena, { asteroids: 8, hunters: 1, asteroidSpeed: [50, 120] });

    list = await (await fetch(`${s.base}/api/rooms`)).json();
    assert.equal(list.rooms.length, 1);
    assert.equal(list.rooms[0].id, made.body.id);
  });
});

test("POST /api/rooms: defaults, validation → 400, not JSON → 400", async () => {
  await withSite(async (s) => {
    const defaults = await createRoom(s.base, { name: "Plain" });
    assert.equal(defaults.status, 201);
    assert.deepEqual(defaults.body.arena, { asteroids: 4, hunters: 1, asteroidSpeed: [40, 100] });

    for (const body of [
      {},
      { name: "" },
      { name: 5 },
      { name: "x".repeat(33) },
      { name: "ok", arena: { asteroids: 99 } },
      { name: "ok", arena: { hunters: -1 } },
      { name: "ok", arena: { asteroidSpeed: [100, 10] } },
      { name: "ok", maxPlayers: 0 },
      { name: "ok", maxPlayers: 999 },
      [],
      null,
    ]) {
      assert.equal((await createRoom(s.base, body)).status, 400, JSON.stringify(body));
    }
    const garbage = await fetch(`${s.base}/api/rooms`, { method: "POST", body: "{nope" });
    assert.equal(garbage.status, 400);
  });
});

test("POST /api/rooms: an oversized body is refused with 413", async () => {
  const s = await startApp({ MAX_BODY_BYTES: "256" });
  try {
    const big = JSON.stringify({ name: "x", pad: "y".repeat(5000) });
    const res = await fetch(`${s.base}/api/rooms`, { method: "POST", body: big });
    assert.equal(res.status, 413);
    // also when the size is not declared up front (chunked)
    const chunked = await fetch(`${s.base}/api/rooms`, {
      method: "POST",
      duplex: "half",
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big));
          c.close();
        },
      }),
    });
    assert.equal(chunked.status, 413);
    assert.equal((await fetch(`${s.base}/health`)).status, 200, "server is still fine");
  } finally {
    await s.close();
  }
});

test("rooms-per-server cap → 409; wrong method → 405 with Allow; unknown /api → 404", async () => {
  const s = await startApp({ MAX_ROOMS: "1" });
  try {
    assert.equal((await createRoom(s.base)).status, 201);
    assert.equal((await createRoom(s.base)).status, 409);
    const del = await fetch(`${s.base}/api/rooms`, { method: "DELETE" });
    assert.equal(del.status, 405);
    assert.equal(del.headers.get("allow"), "GET, POST");
    assert.equal((await fetch(`${s.base}/api/nothing`)).status, 404);
  } finally {
    await s.close();
  }
});

test("debug routes are off unless ENABLE_DEBUG_ROUTES is set", async () => {
  const off = await startApp();
  const on = await startApp({ ENABLE_DEBUG_ROUTES: "1" });
  try {
    assert.equal((await fetch(`${off.base}/api/slow?ms=10`)).status, 404);
    const res = await fetch(`${on.base}/api/slow?ms=10`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { blockedMs: 10 });
  } finally {
    await off.close();
    await on.close();
  }
});

test("a malformed request does not crash the server", async () => {
  await withSite(async (s) => {
    const r = await new Promise((resolve) => {
      const socket = net.connect(s.port, "127.0.0.1", () =>
        socket.write("NOT HTTP AT ALL\r\n\r\n"),
      );
      let data = "";
      socket.on("data", (c) => (data += c));
      socket.on("close", () => resolve(data));
    });
    assert.match(r, /^HTTP\/1\.1 400/);
    assert.equal((await fetch(`${s.base}/health`)).status, 200);
  });
});
