// Records ONE 30-second play session in real Chromium, against the real server, with 8 bots in
// the room — and writes down what the profiler would show:
//
//   • frame time (CPU time of a frame and time between frames): p50/p95/p99, from client/src/perf.ts
//   • every garbage collection (V8's own trace events): how many, how long, minor vs major
//   • the JS heap over time (the sawtooth)
//   • with --profile: a CPU profile (self time per function) and a sampling heap profile
//     (which functions allocate the most) taken through the DevTools protocol
//
//   node tools/lab07/record-session.ts --label=before [--seconds=30] [--bots=8] [--profile]
//
// The numbers are only comparable with themselves: same machine, same build, same scenario.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { z } from "zod";
import { selfTime, topAllocators } from "./profile-util.ts";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k ?? "", v ?? "1"];
  }),
);
const LABEL = args.label ?? "run";
const SECONDS = Number(args.seconds ?? 30);
const BOTS = Number(args.bots ?? 8);
const PROFILE = "profile" in args;
const PORT = Number(args.port ?? 3200);
const ROOT = join(import.meta.dirname, "../..");
const OUT = join(ROOT, "docs/lab-07", LABEL);
mkdirSync(OUT, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── the server ───────────────────────────────────────────────────────────────────────────
const logDir = mkdtempSync(join(tmpdir(), "lab07-"));
const server = spawn(process.execPath, [join(ROOT, "server/src/index.ts")], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    LOG_DIR: logDir,
    CLIENT_DIST: join(ROOT, args.dist ?? "client/dist"),
    MAX_PLAYERS_PER_ROOM: "16",
    NODE_ENV: "development",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/health`)).ok) break;
  } catch {
    await sleep(100);
  }
}

const room = z.object({ id: z.string() }).parse(
  await (
    await fetch(`${base}/api/rooms`, {
      method: "POST",
      body: JSON.stringify({
        name: "Profile",
        maxPlayers: 16,
        arena: { asteroids: 8, hunters: 2, asteroidSpeed: [50, 120] },
      }),
    })
  ).json(),
);

// ── the browser ──────────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ args: ["--enable-precise-memory-info"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (err) => console.error("pageerror:", err.message));
await page.goto(`${base}/`);
await page.locator(`li:has-text("Profile") input[type=radio]`).check();
await page.fill("#lobby-name", "Pilot");
await page.click("button[type=submit]");
await page.waitForFunction(() => window.__net?.session.predictor);
await fetch(`${base}/api/rooms/${room.id}/bots`, {
  method: "POST",
  body: JSON.stringify({ count: BOTS }),
});

/** A pilot who never stops: thrust, fire, and a turn that flips every 1.2 s. */
async function pilot(page: Page, seconds: number, heap: number[]): Promise<void> {
  await page.keyboard.down("ArrowUp");
  await page.keyboard.down("Space");
  const end = Date.now() + seconds * 1000;
  let turning: "ArrowLeft" | "ArrowRight" = "ArrowLeft";
  let nextFlip = 0;
  while (Date.now() < end) {
    if (Date.now() >= nextFlip) {
      await page.keyboard.up(turning);
      turning = turning === "ArrowLeft" ? "ArrowRight" : "ArrowLeft";
      await page.keyboard.down(turning);
      nextFlip = Date.now() + 1200;
    }
    heap.push(await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0));
    await sleep(250);
  }
  await page.keyboard.up("ArrowUp");
  await page.keyboard.up("Space");
  await page.keyboard.up(turning);
}

// warm-up: the JIT needs iterations, and the bots need to find each other
await pilot(page, 6, []);
await page.evaluate(() => window.__perf?.reset());

const cdp = await page.context().newCDPSession(page);
if (PROFILE) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 }); // µs
  await cdp.send("Profiler.start");
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
await browser.startTracing(page, {
  categories: [
    "devtools.timeline",
    "v8",
    "disabled-by-default-v8.gc",
    "disabled-by-default-v8.gc_stats",
  ],
});
const heap: number[] = [];
const traceStart = Date.now();
await pilot(page, SECONDS, heap);
const traceBuffer = await browser.stopTracing();

// ── collect ──────────────────────────────────────────────────────────────────────────────
const report = z
  .record(
    z.string(),
    z.object({
      n: z.number(),
      mean: z.number(),
      p50: z.number(),
      p95: z.number(),
      p99: z.number(),
      max: z.number(),
    }),
  )
  .parse(await page.evaluate(() => window.__perf?.report()));

const traceEvents = z
  .object({
    traceEvents: z.array(
      z.object({
        name: z.string(),
        ph: z.string(),
        ts: z.number(),
        dur: z.number().optional(),
        args: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
  })
  .parse(JSON.parse(traceBuffer.toString("utf8"))).traceEvents;

const gc = traceEvents.filter(
  (e) => (e.name === "MinorGC" || e.name === "MajorGC") && e.ph === "X",
);
const gcSummary = (name: string) => {
  const durs = gc.filter((e) => e.name === name).map((e) => (e.dur ?? 0) / 1000);
  durs.sort((a, b) => a - b);
  return {
    count: durs.length,
    totalMs: Math.round(durs.reduce((s, x) => s + x, 0) * 100) / 100,
    maxMs: Math.round((durs.at(-1) ?? 0) * 100) / 100,
    p99Ms: Math.round((durs[Math.floor(durs.length * 0.99)] ?? 0) * 100) / 100,
  };
};
if ("gcdump" in args) writeFileSync(join(OUT, "gc-events.json"), JSON.stringify(gc, null, 1));
const longTasks = traceEvents.filter((e) => e.name === "RunTask" && (e.dur ?? 0) > 50_000).length;

let cpuTop: unknown = null;
let allocTop: unknown = null;
if (PROFILE) {
  const stopped = await cdp.send("Profiler.stop");
  writeFileSync(join(OUT, "client.cpuprofile"), JSON.stringify(stopped.profile));
  cpuTop = selfTime(stopped.profile);
  const heapProfile = await cdp.send("HeapProfiler.stopSampling");
  allocTop = topAllocators(heapProfile.profile.head);
}
const snapshots = await page.evaluate(() => window.__net?.debug().stats.snapshots ?? 0);
await page.screenshot({ path: join(OUT, "game.png") });
await browser.close();
const statsRes = z
  .object({
    matches: z.array(
      z.object({
        tickDurationMs: z.object({ p50: z.number(), p99: z.number(), max: z.number() }),
        players: z.number(),
        entities: z.number(),
      }),
    ),
  })
  .parse(await (await fetch(`${base}/api/stats`)).json());
server.kill("SIGTERM");

const heapMB = heap.map((b) => b / 1048576);
const summary = {
  label: LABEL,
  seconds: SECONDS,
  bots: BOTS,
  chromium: browser.version(),
  frameCpuMs: report.frame,
  frameIntervalMs: report.interval,
  simulateMs: report.simulate,
  renderMs: report.render,
  decodeMs: report.decode,
  reconcileMs: report.reconcile,
  gc: { minor: gcSummary("MinorGC"), major: gcSummary("MajorGC") },
  longTasksOver50ms: longTasks,
  heapMB: {
    samples: heapMB.length,
    min: Math.round(Math.min(...heapMB) * 10) / 10,
    max: Math.round(Math.max(...heapMB) * 10) / 10,
    series: heapMB.map((x) => Math.round(x * 100) / 100),
  },
  server: statsRes.matches[0] ?? null,
  snapshotsReceived: snapshots,
  traceSeconds: Math.round((Date.now() - traceStart) / 100) / 10,
  cpuTop,
  allocTop,
};
writeFileSync(join(OUT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      ...summary,
      heapMB: { ...summary.heapMB, series: undefined },
      cpuTop: undefined,
      allocTop: undefined,
    },
    null,
    2,
  ),
);
if (PROFILE) {
  console.log("top self time:", JSON.stringify(cpuTop, null, 1));
  console.log("top allocators:", JSON.stringify(allocTop, null, 1));
}
