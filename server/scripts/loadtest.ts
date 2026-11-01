// Capacity test: how many clients can ONE server process carry before its 30 Hz tick no longer
// fits in 33 ms? For each N it starts a fresh server, connects N headless clients (spread over a
// few OS processes so that the measuring tool does not steal the server's CPU), lets them fly
// for a while, and samples /api/stats once a second.
//
//   node scripts/loadtest.ts [--sizes=8,32,64,128] [--seconds=20] [--mode=rooms|room|both]
//                            [--procs=3] [--label=after] [--cpu-prof]
//
//   mode "rooms": N clients in rooms of 8 (the game as designed: many small matches, one event loop)
//   mode "room" : all N clients in ONE match (the worst case for per-match work that grows as N²)

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseArgs, sleep } from "./common.ts";

const args = parseArgs();
const SIZES = (args.sizes ?? "8,32,64,128").split(",").map(Number);
const SECONDS = Number(args.seconds ?? 20);
const MODE = args.mode ?? "both";
const PROCS = Number(args.procs ?? 3);
const LABEL = args.label ?? "run";
const PORT = Number(args.port ?? 3400);
const ROOT = join(import.meta.dirname, "../..");
const OUT = join(ROOT, "docs/lab-07", LABEL);
mkdirSync(OUT, { recursive: true });

const summary = z.object({
  n: z.number(),
  mean: z.number(),
  p50: z.number(),
  p99: z.number(),
  max: z.number(),
});
const stats = z.object({
  rssBytes: z.number(),
  heapUsedBytes: z.number(),
  eventLoop: z.object({ idleMs: z.number(), activeMs: z.number() }),
  matches: z.array(
    z.object({
      players: z.number(),
      entities: z.number(),
      tickDurationMs: summary,
      tickLatenessMs: summary,
      overruns: z.number(),
      skippedTicks: z.number(),
      bytesOutPerSec: z.number(),
    }),
  ),
});
const roomSchema = z.object({ id: z.string() });

export interface Point {
  mode: string;
  n: number;
  joined: number;
  matches: number;
  tickMeanMs: number;
  tickP99Ms: number;
  tickMaxMs: number;
  latenessP99Ms: number;
  tickBusyPct: number; // all matches' mean tick time × 30 Hz, as a share of one second
  eventLoopUtilizationPct: number;
  rssMB: number;
  heapMB: number;
  kbPerSecOut: number;
  skippedTicks: number;
}

async function once(mode: "rooms" | "room", n: number): Promise<Point> {
  const logDir = mkdtempSync(join(tmpdir(), "lab07-load-"));
  const nodeArgs =
    "cpu-prof" in args
      ? ["--cpu-prof", `--cpu-prof-dir=${OUT}`, "--cpu-prof-name=server.cpuprofile"]
      : [];
  const server = spawn(process.execPath, [...nodeArgs, join(ROOT, "server/src/index.ts")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      LOG_DIR: logDir,
      MAX_ROOMS: "1000",
      MAX_PLAYERS_PER_ROOM: String(mode === "room" ? Math.max(n, 8) : 8),
      ENABLE_NETSIM: "0",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const exited = new Promise<void>((r) => server.on("exit", () => r()));
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      await sleep(100);
    }
  }
  const create = async (name: string, maxPlayers: number): Promise<string> =>
    roomSchema.parse(
      await (
        await fetch(`${base}/api/rooms`, {
          method: "POST",
          body: JSON.stringify({
            name,
            maxPlayers,
            arena: { asteroids: 8, hunters: 2, asteroidSpeed: [50, 120] },
          }),
        })
      ).json(),
    ).id;
  const roomIds: string[] = [];
  if (mode === "room") roomIds.push(await create("big", n));
  else for (let r = 0; r < Math.ceil(n / 8); r++) roomIds.push(await create(`r${r}`, 8));
  const perRoom = mode === "room" ? n : 8;

  // the clients: PROCS OS processes, each with its share
  const perProc = Math.ceil(n / PROCS);
  const children = Array.from({ length: PROCS }, (_, p) => {
    const count = Math.min(perProc, n - p * perProc);
    if (count <= 0) return null;
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dirname, "loadtest-clients.ts"),
        `--url=ws://127.0.0.1:${PORT}/ws`,
        `--rooms=${roomIds.join(",")}`,
        `--count=${count}`,
        `--per-room=${perRoom}`,
        `--offset=${p * perProc}`,
        `--seconds=${SECONDS + 8}`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    return { child, output: () => out };
  }).filter((c) => c !== null);

  // wait until everybody is in
  let players = 0;
  for (let i = 0; i < 100 && players < n; i++) {
    await sleep(200);
    const s = stats.parse(await (await fetch(`${base}/api/stats`)).json());
    players = s.matches.reduce((sum, m) => sum + m.players, 0);
  }
  await sleep(3000); // let the JIT and the rolling windows settle

  const samples: {
    tickMean: number;
    tickP99: number;
    tickMax: number;
    lateP99: number;
    busy: number;
    elu: number;
    rss: number;
    heap: number;
    kb: number;
    skipped: number;
  }[] = [];
  let prev = stats.parse(await (await fetch(`${base}/api/stats`)).json());
  for (let i = 0; i < SECONDS; i++) {
    await sleep(1000);
    const s = stats.parse(await (await fetch(`${base}/api/stats`)).json());
    const active = s.eventLoop.activeMs - prev.eventLoop.activeMs;
    const idle = s.eventLoop.idleMs - prev.eventLoop.idleMs;
    const ms = s.matches;
    samples.push({
      tickMean: avg(ms.map((m) => m.tickDurationMs.mean)),
      tickP99: Math.max(0, ...ms.map((m) => m.tickDurationMs.p99)),
      tickMax: Math.max(0, ...ms.map((m) => m.tickDurationMs.max)),
      lateP99: Math.max(0, ...ms.map((m) => m.tickLatenessMs.p99)),
      busy: (ms.reduce((sum, m) => sum + m.tickDurationMs.mean, 0) * 30) / 10,
      elu: (100 * active) / Math.max(1, active + idle),
      rss: s.rssBytes / 1048576,
      heap: s.heapUsedBytes / 1048576,
      kb: ms.reduce((sum, m) => sum + m.bytesOutPerSec, 0) / 1024,
      skipped: ms.reduce((sum, m) => sum + m.skippedTicks, 0),
    });
    prev = s;
  }
  for (const c of children) c.child.kill("SIGTERM");
  server.kill("SIGINT"); // graceful: also writes the --cpu-prof file
  await exited;

  const point: Point = {
    mode,
    n,
    joined: players,
    matches: prev.matches.length,
    tickMeanMs: round(med(samples.map((s) => s.tickMean))),
    tickP99Ms: round(med(samples.map((s) => s.tickP99))),
    tickMaxMs: round(Math.max(...samples.map((s) => s.tickMax))),
    latenessP99Ms: round(med(samples.map((s) => s.lateP99))),
    tickBusyPct: round(med(samples.map((s) => s.busy))),
    eventLoopUtilizationPct: round(med(samples.map((s) => s.elu))),
    rssMB: round(med(samples.map((s) => s.rss))),
    heapMB: round(med(samples.map((s) => s.heap))),
    kbPerSecOut: round(med(samples.map((s) => s.kb))),
    skippedTicks: Math.max(...samples.map((s) => s.skipped)),
  };
  console.log(JSON.stringify(point));
  return point;
}

const points: Point[] = [];
for (const mode of MODE === "both"
  ? (["rooms", "room"] as const)
  : MODE === "room"
    ? (["room"] as const)
    : (["rooms"] as const)) {
  for (const n of SIZES) points.push(await once(mode, n));
}
writeFileSync(
  join(OUT, "loadtest.json"),
  `${JSON.stringify({ seconds: SECONDS, procs: PROCS, points }, null, 2)}\n`,
);
writeFileSync(join(OUT, "loadtest.svg"), chart(points));
console.log(`wrote ${join(OUT, "loadtest.json")} and loadtest.svg`);

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}
function round(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Two panels: tick time p99 against the 33 ms budget, and event-loop utilization. */
function chart(all: Point[]): string {
  const W = 880;
  const H = 360;
  const colour: Record<string, string> = { rooms: "#2a9d5c", room: "#d9534f" };
  const name: Record<string, string> = { rooms: "rooms of 8", room: "one room" };
  const panel = (
    title: string,
    x0: number,
    value: (p: Point) => number,
    yMax: number,
    unit: string,
    budget?: number,
  ): string => {
    const w = 380;
    const h = 220;
    const top = 60;
    const maxN = Math.max(...all.map((p) => p.n));
    const x = (n: number): number => x0 + 50 + (n / maxN) * (w - 60);
    const y = (v: number): number => top + h - (Math.min(v, yMax) / yMax) * h;
    let svg = `<text x="${x0 + 50}" y="40" font-size="14" font-weight="600" fill="#1b2a35">${title}</text>`;
    for (let t = 0; t <= 4; t++) {
      const v = (yMax / 4) * t;
      svg += `<line x1="${x0 + 50}" x2="${x0 + w - 10}" y1="${y(v)}" y2="${y(v)}" stroke="#e3eaee"/><text x="${x0 + 44}" y="${y(v) + 4}" text-anchor="end" fill="#56707f">${Math.round(v)}</text>`;
    }
    for (const n of [...new Set(all.map((p) => p.n))]) {
      svg += `<text x="${x(n)}" y="${top + h + 18}" text-anchor="middle" fill="#56707f">${n}</text>`;
    }
    svg += `<text x="${x0 + 50 + (w - 60) / 2}" y="${top + h + 38}" text-anchor="middle" fill="#56707f">clients</text><text x="${x0 + 50}" y="${top - 8}" fill="#56707f">${unit}</text>`;
    if (budget !== undefined) {
      svg += `<line x1="${x0 + 50}" x2="${x0 + w - 10}" y1="${y(budget)}" y2="${y(budget)}" stroke="#222" stroke-dasharray="5 4"/><text x="${x0 + w - 12}" y="${y(budget) - 5}" text-anchor="end" fill="#222">${budget} ms budget</text>`;
    }
    for (const mode of ["rooms", "room"]) {
      const pts = all.filter((p) => p.mode === mode);
      if (!pts.length) continue;
      svg += `<polyline fill="none" stroke="${colour[mode]}" stroke-width="2.4" points="${pts.map((p) => `${x(p.n).toFixed(1)},${y(value(p)).toFixed(1)}`).join(" ")}"/>`;
      for (const p of pts)
        svg += `<circle cx="${x(p.n)}" cy="${y(value(p))}" r="3.5" fill="${colour[mode]}"><title>${name[mode]}, N=${p.n}: ${value(p)}</title></circle>`;
    }
    return svg;
  };
  const maxTick = Math.max(40, ...all.map((p) => p.tickP99Ms));
  const yTick = Math.ceil(maxTick / 20) * 20;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="12"><rect width="${W}" height="${H}" fill="#fff"/>`;
  svg += panel("tick time p99 (the budget is 33.3 ms)", 0, (p) => p.tickP99Ms, yTick, "ms", 33.3);
  svg += panel("event-loop utilization", 440, (p) => p.eventLoopUtilizationPct, 100, "%");
  svg += `<g transform="translate(60 ${H - 14})"><rect width="12" height="3" y="-9" fill="${colour.rooms}"/><text x="18" fill="#1b2a35">${name.rooms}</text><rect x="140" width="12" height="3" y="-9" fill="${colour.room}"/><text x="158" fill="#1b2a35">${name.room}</text></g></svg>\n`;
  return svg;
}
