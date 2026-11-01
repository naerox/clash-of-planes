// Event-loop demo (Lab 4, M4): what happens to OTHER clients while one HTTP handler keeps
// the loop busy for 300 ms?
//
//   node scripts/block-demo.js [--block=300] [--blocks=4]
//
// Two WebSocket clients sit in one room. A sends a chat line every 150 ms carrying its send
// time; B measures how late each one arrives. Meanwhile a third client calls GET /api/slow,
// whose handler is a synchronous busy loop. We also time GET /health while the loop is busy.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a) => a.replace(/^--/, "").split("="))
    .map(([k, v]) => [k, v ?? "1"]),
);
const BLOCK_MS = Number(args.block ?? 300);
const BLOCKS = Number(args.blocks ?? 4);

const dir = await mkdtemp(join(tmpdir(), "dogfight-block-"));
const server = spawn(process.execPath, [join(import.meta.dirname, "../src/index.js")], {
  env: { ...process.env, PORT: "0", LOG_DIR: dir, CLIENT_DIST: dir, ENABLE_DEBUG_ROUTES: "1" },
  stdio: ["ignore", "pipe", "inherit"],
});
const base = await new Promise((resolve) => {
  let buf = "";
  server.stdout.on("data", (c) => {
    buf += c;
    const m = buf.match(/"url":"(http:\/\/[^"]+)"/);
    if (m) resolve(m[1]);
  });
});

const room = await (
  await fetch(`${base}/api/rooms`, { method: "POST", body: JSON.stringify({ name: "Block" }) })
).json();
const client = (name) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    ws.on("open", () => ws.send(JSON.stringify({ v: 1, type: "join", room: room.id, name })));
    ws.on("message", function first(d) {
      if (JSON.parse(d).type === "joined") {
        ws.off("message", first);
        resolve(ws);
      }
    });
  });
const a = await client("A");
const b = await client("B");

const lat = []; // { sentAt, ms }
b.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.type === "chat" && m.text.startsWith("t=")) {
    const sentAt = Number(m.text.slice(2));
    lat.push({ sentAt, ms: Date.now() - sentAt });
  }
});
const timer = setInterval(
  () => a.send(JSON.stringify({ v: 1, type: "chat", text: `t=${Date.now()}` })),
  150,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3000);
const calmEnd = Date.now();

const health = [];
for (let i = 0; i < BLOCKS; i++) {
  const slow = fetch(`${base}/api/slow?ms=${BLOCK_MS}`);
  await sleep(20); // the request is in; the server is now inside the busy loop
  const t0 = performance.now();
  await fetch(`${base}/health`); // queued behind the loop
  health.push(performance.now() - t0);
  await slow;
  await sleep(1000);
}
clearInterval(timer);
await sleep(300);

const stats = (xs) => {
  const s = [...xs].sort((p, q) => p - q);
  return { n: s.length, p50: s[Math.floor(s.length / 2)], max: s.at(-1) };
};
const calm = stats(lat.filter((l) => l.sentAt < calmEnd - 300).map((l) => l.ms));
const busy = stats(lat.filter((l) => l.sentAt >= calmEnd).map((l) => l.ms));
console.log(
  `chat delivery A→B through the server (ms), blocking handler = ${BLOCK_MS} ms × ${BLOCKS}`,
);
console.table({ "no blocking": calm, "with /api/slow": busy });
console.log(
  `GET /health while the loop is busy (ms): ${health.map((h) => h.toFixed(0)).join(", ")}`,
);

a.close();
b.close();
server.kill("SIGTERM");
await rm(dir, { recursive: true, force: true });
