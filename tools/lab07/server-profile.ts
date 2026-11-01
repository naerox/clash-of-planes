// Profiles the SERVER for a minute with `node --cpu-prof`: a room with 8 bots (the same AI that
// runs in the browser recording), then reports tick-time percentiles from /api/stats and the
// functions that took the CPU.
//
//   node tools/lab07/server-profile.ts --label=before [--seconds=60] [--bots=8] [--players=1]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { selfTime } from "./profile-util.ts";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k ?? "", v ?? "1"];
  }),
);
const LABEL = args.label ?? "run";
const SECONDS = Number(args.seconds ?? 60);
const BOTS = Number(args.bots ?? 8);
const PORT = Number(args.port ?? 3300);
const ROOT = join(import.meta.dirname, "../..");
const OUT = join(ROOT, "docs/lab-07", LABEL);
mkdirSync(OUT, { recursive: true });
const profDir = mkdtempSync(join(tmpdir(), "lab07-srvprof-"));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const server = spawn(
  process.execPath,
  [
    "--cpu-prof",
    `--cpu-prof-dir=${profDir}`,
    "--cpu-prof-interval=500",
    join(ROOT, "server/src/index.ts"),
  ],
  {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      LOG_DIR: mkdtempSync(join(tmpdir(), "lab07-log-")),
      MAX_PLAYERS_PER_ROOM: "64",
      MAX_CONNECTIONS_PER_IP: "100000",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "ignore", "inherit"],
  },
);
const exited = new Promise<void>((r) => server.on("exit", () => r()));
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
        name: "Server profile",
        maxPlayers: 64,
        arena: { asteroids: 8, hunters: 2, asteroidSpeed: [50, 120] },
      }),
    })
  ).json(),
);
// a bots-only room is deleted when its last human leaves, so one real socket holds it open
const holder = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise<void>((r) => holder.addEventListener("open", () => r()));
holder.send(JSON.stringify({ v: 1, type: "join", room: room.id, name: "holder", codec: "json" }));
await sleep(300);
await fetch(`${base}/api/rooms/${room.id}/bots`, {
  method: "POST",
  body: JSON.stringify({ count: BOTS }),
});

const summary = z.object({
  n: z.number(),
  mean: z.number(),
  p50: z.number(),
  p99: z.number(),
  max: z.number(),
});
const stats = z.object({
  rssBytes: z.number().optional(),
  matches: z.array(
    z.object({
      players: z.number(),
      entities: z.number(),
      tickDurationMs: summary,
      tickLatenessMs: summary,
      overruns: z.number(),
    }),
  ),
});
const series: z.infer<typeof stats>["matches"][number][] = [];
await sleep(5000); // warm-up
const t0 = Date.now();
while (Date.now() - t0 < SECONDS * 1000) {
  const s = stats.parse(await (await fetch(`${base}/api/stats`)).json());
  const m = s.matches[0];
  if (m) series.push(m);
  await sleep(2000);
}
holder.close();
await sleep(300);
server.kill("SIGTERM");
await exited;

const file = readdirSync(profDir).find((f) => f.endsWith(".cpuprofile"));
const top = file ? selfTime(JSON.parse(readFileSync(join(profDir, file), "utf8"))) : [];
const p99s = series.map((m) => m.tickDurationMs.p99).sort((a, b) => a - b);
const result = {
  label: LABEL,
  seconds: SECONDS,
  players: series.at(-1)?.players,
  entities: series.at(-1)?.entities,
  tickMs: {
    p50: median(series.map((m) => m.tickDurationMs.p50)),
    meanOfMeans: round(
      series.reduce((s, m) => s + m.tickDurationMs.mean, 0) / Math.max(1, series.length),
    ),
    p99Median: median(p99s),
    p99Worst: p99s.at(-1),
    max: Math.max(...series.map((m) => m.tickDurationMs.max)),
  },
  overruns: series.at(-1)?.overruns,
  top,
};
writeFileSync(join(OUT, "server-summary.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 1));
if (file) writeFileSync(join(OUT, "server.cpuprofile"), readFileSync(join(profDir, file)));

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return round(s[Math.floor(s.length / 2)] ?? 0);
}
