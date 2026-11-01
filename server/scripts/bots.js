// Headless clients against a REAL server (Lab 5 Stretch: "your first netcode regression test").
//
//   node scripts/bots.js [--url=http://127.0.0.1:3000] [--bots=4] [--seconds=20]
//                        [--lag=150] [--jitter=30] [--drop=0.05] [--codec=binary|json]
//                        [--max-correction=2] [--spawn]
//
// Each bot is the real browser netcode (Connection + GameSession: prediction, reconciliation,
// interpolation, the codec) minus the canvas: it flies a scripted dogfight, hunting the nearest
// ship. At the end it prints what the netgraph would have shown, and the script fails (exit 1)
// if the mean reconciliation correction is above --max-correction. With --spawn it starts its
// own server on a random port first. The server's /api/stats is printed too.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { ARENA, STEP_MS, wrappedDelta } from "@dogfight/shared";
import { Connection } from "../../client/src/net/connection.js";
import { msg } from "../../client/src/net/protocol.js";
import { GameSession } from "../../client/src/game/session.js";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a) => a.replace(/^--/, "").split("="))
    .map(([k, v]) => [k, v ?? "1"]),
);
const N = Number(args.bots ?? 4);
const SECONDS = Number(args.seconds ?? 20);
const codec = args.codec ?? "binary";
const query = new URLSearchParams();
for (const key of ["lag", "jitter", "drop"]) if (args[key]) query.set(key, args[key]);
const MAX_CORRECTION = Number(args["max-correction"] ?? Infinity);

let server = null;
let base = args.url ?? "http://127.0.0.1:3000";
if (args.spawn) {
  server = spawn(process.execPath, [join(import.meta.dirname, "../src/index.js")], {
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      LOG_DIR: join(process.env.TMPDIR ?? "/tmp", `bots-${process.pid}`),
      CLIENT_DIST: ".",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  base = await new Promise((resolve) => {
    let buf = "";
    server.stdout.on("data", (c) => {
      buf += c;
      const m = buf.match(/"url":"(http:\/\/[^"]+)"/);
      if (m) resolve(m[1]);
    });
  });
}

const room = await (
  await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Bots",
      maxPlayers: 8,
      arena: { asteroids: 4, hunters: 1, asteroidSpeed: [40, 90] },
    }),
  })
).json();

/** Steer toward the nearest other ship, shoot when roughly aimed. */
function autopilot(scene) {
  const me = scene.me;
  if (!me || me.dead) return { thrust: false, turn: 0, fire: false };
  let best = null;
  for (const s of scene.ships) {
    if (s.isMe || s.dead) continue;
    const dx = wrappedDelta(me.x, s.x, ARENA.width);
    const dy = wrappedDelta(me.y, s.y, ARENA.height);
    const d = Math.hypot(dx, dy);
    if (!best || d < best.d) best = { dx, dy, d };
  }
  if (!best) return { thrust: true, turn: 1, fire: false };
  let diff = Math.atan2(best.dy, best.dx) - me.angle;
  diff -= Math.PI * 2 * Math.round(diff / (Math.PI * 2));
  return {
    thrust: best.d > 320,
    turn: diff > 0.08 ? 1 : diff < -0.08 ? -1 : 0,
    fire: Math.abs(diff) < 0.15 && best.d < 900,
  };
}

const percentile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)] ?? 0;

async function runBot(index) {
  const name = `bot${index}`;
  const url = `${base.replace("http", "ws")}/ws${query.size ? `?${query}` : ""}`;
  const connection = new Connection({ url, handshake: () => msg.join(room.id, name, codec) });
  const joined = await new Promise((resolve, reject) => {
    connection.addEventListener("joined", (e) => resolve(e.detail), { once: true });
    connection.addEventListener("closed", (e) => reject(new Error(`closed ${e.detail.code}`)), {
      once: true,
    });
    connection.connect();
  });
  const session = new GameSession({ joined, sendNow: (d) => connection.sendNow(d) });
  connection.addEventListener("frame", (e) => session.noteFrame(e.detail.size));
  connection.addEventListener("binary", (e) => session.handleBinary(e.detail));
  connection.addEventListener("snapshot", (e) => session.handleMessage(e.detail));
  connection.addEventListener("pong", (e) => session.handleMessage(e.detail));
  connection.addEventListener("roster", (e) => session.setPlayers(e.detail.players));

  const t0 = performance.now();
  let stepNo = 0;
  let scene = { me: null, ships: [] };
  const stepTimer = (function loop() {
    // an absolute-target loop, like the server's
    const wait = Math.max(0, t0 + ++stepNo * STEP_MS - performance.now());
    return setTimeout(() => {
      scene = session.render(performance.now(), 0.5, STEP_MS);
      session.step(autopilot(scene));
      if (performance.now() - t0 < SECONDS * 1000) loop();
    }, wait);
  })();
  const pinger = setInterval(() => session.ping(), 500);
  await new Promise((r) => setTimeout(r, SECONDS * 1000 + 300));
  clearInterval(pinger);
  clearTimeout(stepTimer);
  const stats = session.stats.report();
  const corrections = session.stats.corrections.values.slice(30);
  connection.close();
  return {
    bot: name,
    rtt: Math.round(stats.rttMs),
    "loss %": +stats.lossPercent.toFixed(1),
    "starved %": +stats.starvedPercent.toFixed(2),
    "↓ KB/s": +(stats.downBytesPerSec / 1024).toFixed(1),
    "↑ KB/s": +(stats.upBytesPerSec / 1024).toFixed(2),
    "B/snap": Math.round(stats.avgSnapshotBytes),
    "corr mean": +(
      corrections.reduce((s, x) => s + x, 0) / Math.max(1, corrections.length)
    ).toFixed(3),
    "corr p95": +percentile(corrections, 0.95).toFixed(2),
    "corr max": +Math.max(0, ...corrections).toFixed(2),
    respawns: stats.teleports,
    score: scene.me?.score ?? 0,
  };
}

console.log(`${N} bots, ${SECONDS} s, codec ${codec}, link ${query.toString() || "(none)"}`);
const rows = await Promise.all(Array.from({ length: N }, (_, i) => runBot(i)));
console.table(rows);

const stats = await (await fetch(`${base}/api/stats`)).json();
const m = stats.matches.find((x) => x.room === room.id);
if (m) {
  console.log(
    `server: tick duration mean ${m.tickDurationMs.mean} ms (p99 ${m.tickDurationMs.p99}, max ${m.tickDurationMs.max}); ` +
      `lateness mean ${m.tickLatenessMs.mean} ms (p99 ${m.tickLatenessMs.p99}, max ${m.tickLatenessMs.max}); ` +
      `interval ${m.tickIntervalMs.mean} ± ${m.tickIntervalMs.stdev} ms; overruns ${m.overruns}; skipped ${m.skippedTicks}; ` +
      `inputs applied ${m.inputsApplied}, rejected ${m.inputsRejected}; out ${(m.bytesOutPerSec / 1024).toFixed(1)} KB/s`,
  );
}
server?.kill("SIGTERM");

const worst = Math.max(...rows.map((r) => r["corr mean"]));
if (worst > MAX_CORRECTION) {
  console.error(`FAIL: mean correction ${worst} > ${MAX_CORRECTION}`);
  process.exit(1);
}
console.log(`ok: mean correction ${worst} ≤ ${MAX_CORRECTION} (respawns are counted separately)`);
process.exit(0);
