// Headless clients against a REAL server (Lab 5 Stretch: "your first netcode regression test").
//
//   node scripts/bots.ts [--url=http://127.0.0.1:3000] [--bots=4] [--seconds=20]
//                        [--lag=150] [--jitter=30] [--drop=0.05] [--codec=binary|json]
//                        [--max-correction=2] [--spawn]
//
// Each bot is the real browser netcode (Connection + GameSession: prediction, reconciliation,
// interpolation, the codec) minus the canvas: it flies a scripted dogfight, hunting the nearest
// ship. At the end it prints what the netgraph would have shown, and the script fails (exit 1)
// if the mean reconciliation correction is above --max-correction. With --spawn it starts its
// own server on a random port first. The server's /api/stats is printed too.

import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import {
  ARENA,
  STEP_MS,
  roomInfoSchema,
  wrappedDelta,
  type CodecName,
  type JoinedMessage,
} from "@dogfight/shared";
import { z } from "zod";
import type { PlayerControls } from "../../client/src/input.ts";
import type { Scene } from "../../client/src/game/scene.ts";
import { Connection } from "../../client/src/net/connection.ts";
import { msg } from "../../client/src/net/protocol.ts";
import { GameSession } from "../../client/src/game/session.ts";
import { parseArgs, startServer } from "./common.ts";

const args = parseArgs();
const N = Number(args.bots ?? 4);
const SECONDS = Number(args.seconds ?? 20);
const codec: CodecName = args.codec === "json" ? "json" : "binary";
const query = new URLSearchParams();
for (const key of ["lag", "jitter", "drop"]) {
  const value = args[key];
  if (value) query.set(key, value);
}
const MAX_CORRECTION = Number(args["max-correction"] ?? Infinity);

let server: ChildProcess | null = null;
let base = args.url ?? "http://127.0.0.1:3000";
if (args.spawn) {
  const started = await startServer(join(import.meta.dirname, "../src/index.ts"), {
    PORT: "0",
    HOST: "127.0.0.1",
    LOG_DIR: join(process.env.TMPDIR ?? "/tmp", `bots-${process.pid}`),
    CLIENT_DIST: ".",
    NODE_ENV: "development",
  });
  server = started.child;
  base = started.base;
}

const room = roomInfoSchema.parse(
  await (
    await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bots",
        maxPlayers: 8,
        arena: { asteroids: 4, hunters: 1, asteroidSpeed: [40, 90] },
      }),
    })
  ).json(),
);

/** Steer toward the nearest other ship, shoot when roughly aimed. */
function autopilot(scene: Scene): PlayerControls {
  const me = scene.me;
  if (!me || me.dead) return { thrust: false, turn: 0, fire: false };
  let best: { dx: number; dy: number; d: number } | null = null;
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

const percentile = (xs: readonly number[], q: number): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)] ?? 0;

async function runBot(index: number) {
  const name = `bot${index}`;
  const url = `${base.replace("http", "ws")}/ws${query.size ? `?${query}` : ""}`;
  const connection = new Connection({ url, handshake: () => msg.join(room.id, name, codec) });
  const joined = await new Promise<JoinedMessage>((resolve, reject) => {
    connection.on("joined", resolve, { once: true });
    connection.on("closed", (e) => reject(new Error(`closed ${e.code}`)), { once: true });
    connection.connect();
  });
  const session = new GameSession({ joined, sendNow: (d) => connection.sendNow(d) });
  connection.on("frame", (e) => session.noteFrame(e.size));
  connection.on("binary", (data) => session.handleBinary(data));
  connection.on("snapshot", (m) => session.handleMessage(m));
  connection.on("pong", (m) => session.handleMessage(m));
  connection.on("roster", (m) => session.setPlayers(m.players));

  const t0 = performance.now();
  let stepNo = 0;
  const latest: { scene: Scene | null } = { scene: null };
  const stepTimer = (function loop() {
    // an absolute-target loop, like the server's
    const wait = Math.max(0, t0 + ++stepNo * STEP_MS - performance.now());
    return setTimeout(() => {
      const current = session.render(performance.now(), 0.5, STEP_MS);
      latest.scene = current;
      session.step(autopilot(current));
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
    score: latest.scene?.me?.score ?? 0,
  };
}

console.log(`${N} bots, ${SECONDS} s, codec ${codec}, link ${query.toString() || "(none)"}`);
const rows = await Promise.all(Array.from({ length: N }, (_, i) => runBot(i)));
console.table(rows);

const summaryStats = z.object({
  mean: z.number(),
  p99: z.number(),
  max: z.number(),
  stdev: z.number(),
});
const matchSummary = z.object({
  room: z.string(),
  tickDurationMs: summaryStats,
  tickLatenessMs: summaryStats,
  tickIntervalMs: summaryStats,
  overruns: z.number(),
  skippedTicks: z.number(),
  inputsApplied: z.number(),
  inputsRejected: z.number(),
  bytesOutPerSec: z.number(),
});
const stats = z
  .object({ matches: z.array(matchSummary) })
  .parse(await (await fetch(`${base}/api/stats`)).json());
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
