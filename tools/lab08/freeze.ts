// "Prove it to yourself" 5: freeze the process for ~5 s (`kill -STOP`, then `kill -CONT`) while a
// bot match is running, and see what each probe says.
//   node tools/lab08/freeze.ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startServer } from "../../server/scripts/common.ts";

const ROOT = join(import.meta.dirname, "../..");
const dir = mkdtempSync(join(tmpdir(), "dogfight-freeze-"));
const { child, base } = await startServer(join(ROOT, "server/src/index.ts"), {
  PORT: "0",
  HOST: "127.0.0.1",
  LOG_DIR: dir,
  CLIENT_DIST: dir,
  NODE_ENV: "development",
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const room = z.object({ id: z.string() }).parse(
  await (
    await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Freeze", maxPlayers: 8 }),
    })
  ).json(),
);
await fetch(`${base}/api/rooms/${room.id}/bots`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ count: 6 }),
});
await sleep(5000);

const probe = async (path: string, ms = 1000): Promise<{ ok: boolean; ms: number }> => {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(ms) });
    await res.text();
    return { ok: res.ok, ms: Math.round(performance.now() - t0) };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - t0) };
  }
};
const elu = async (): Promise<number> => {
  const text = await (await fetch(`${base}/metrics`)).text();
  return Number(
    text
      .split("\n")
      .find((l) => l.startsWith("dogfight_event_loop_utilization "))
      ?.split(" ")[1],
  );
};
const tickStats = async () => {
  const s = z
    .object({
      matches: z.array(
        z.object({
          tickIntervalMs: z.object({ max: z.number() }),
          tickLatenessMs: z.object({ max: z.number() }),
          skippedTicks: z.number(),
        }),
      ),
    })
    .parse(await (await fetch(`${base}/api/stats`)).json());
  return s.matches[0];
};

await elu(); // the first scrape only sets the reference point
await sleep(2000);
const before = { health: await probe("/health"), elu: await elu(), tick: await tickStats() };

process.kill(child.pid ?? 0, "SIGSTOP");
const during = [await probe("/health"), await probe("/ready"), await probe("/metrics")];
await sleep(1000);
const duringLater = await probe("/health");
process.kill(child.pid ?? 0, "SIGCONT");
await sleep(300);
const after = { health: await probe("/health"), elu: await elu(), tick: await tickStats() };

const result = {
  beforeFreeze: before,
  frozenFor: "about 5 s (three 1 s probes, a 1 s pause, one more probe)",
  whileFrozen: {
    health: during[0],
    ready: during[1],
    metrics: during[2],
    healthAgain: duringLater,
  },
  afterResume: after,
};
console.log(JSON.stringify(result, null, 2));
mkdirSync(join(ROOT, "docs/lab-08"), { recursive: true });
writeFileSync(join(ROOT, "docs/lab-08/freeze.json"), `${JSON.stringify(result, null, 2)}\n`);
child.kill("SIGTERM");
