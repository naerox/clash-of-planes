// "Move one subsystem to a Web Worker and keep it only if the main thread got faster."
//
// The candidate: decoding the server's snapshots (bytes → objects), the one piece of per-message
// work the client does that is separable from the rest. Two variants run in real Chromium:
//
//   main    decode in place on the main thread (with the recycler the game uses now)
//   worker  transfer the bytes to a Worker, decode there, post the decoded snapshot back
//
// What is measured is the MAIN THREAD's CPU time (DevTools `Performance.getMetrics` →
// `TaskDuration`, which includes dispatching messages and deserialising the replies), per snapshot.
//
//   node tools/lab07/worker-bench.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { rolldown } from "rolldown";
import { World, binaryCodec, buildSnapshot, seq } from "@dogfight/shared";

const ROOT = join(import.meta.dirname, "../..");
const OUT = join(ROOT, "docs/lab-07/worker");
mkdirSync(OUT, { recursive: true });

const bundle = await rolldown({ input: join(import.meta.dirname, "worker-entry.ts") });
const { output } = await bundle.generate({ format: "iife", name: "codecs" });
const code = output[0].code;

function frameWithShips(ships: number): number[] {
  const world = new World({ seed: 3, arena: { asteroids: 8, asteroidSpeed: [40, 80] } }).populate();
  const made = Array.from({ length: ships }, (_, i) => world.addShip(`p${i}`));
  made.forEach((s, i) => s.fire(world, seq(i + 1)));
  for (let i = 0; i < 4; i++) world.step(1 / 30);
  const first = made[0];
  if (!first) throw new Error("no ships");
  return [...binaryCodec.encode(buildSnapshot(world, { shipId: first.id, ack: seq(1) }))];
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<html><body>bench</body></html>");
await page.addScriptTag({ content: code });
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");

const taskSeconds = async (): Promise<number> => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find((m) => m.name === "TaskDuration")?.value ?? 0;
};

const results: { ships: number; bytes: number; mainUs: number; workerUs: number }[] = [];
for (const ships of [9, 64, 128]) {
  const frame = frameWithShips(ships);
  const N = 4000;
  const measure = async (variant: "main" | "worker"): Promise<number> => {
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300))); // settle
    const before = await taskSeconds();
    await page.evaluate(
      async ({ frame, N, variant }) => {
        const codecs = window.codecs;
        if (!codecs) throw new Error("codec bundle missing");
        const bytes = new Uint8Array(frame);
        if (variant === "main") {
          const recycler = new codecs.SnapshotRecycler();
          for (let i = 0; i < N; i++) recycler.release(codecs.binaryCodec.decode(bytes, recycler));
          return;
        }
        const src = `${window.__code ?? ""}
          onmessage = (e) => { postMessage(codecs.binaryCodec.decode(new Uint8Array(e.data))); };`;
        const worker = new Worker(
          URL.createObjectURL(new Blob([src], { type: "text/javascript" })),
        );
        let got = 0;
        await new Promise<void>((resolve) => {
          worker.onmessage = () => {
            if (++got === N) resolve();
          };
          for (let i = 0; i < N; i++) {
            const copy = new Uint8Array(bytes); // a fresh buffer per message, like a WebSocket frame
            worker.postMessage(copy.buffer, [copy.buffer]);
          }
        });
        worker.terminate();
      },
      { frame, N, variant },
    );
    return (((await taskSeconds()) - before) / N) * 1e6;
  };
  await page.evaluate((c) => {
    window.__code = c;
  }, code);
  const mainUs = await measure("main");
  const workerUs = await measure("worker");
  results.push({ ships, bytes: frame.length, mainUs, workerUs });
}
await browser.close();

console.log("ships | frame bytes | main thread µs/snapshot: decode inline | via worker | verdict");
for (const r of results)
  console.log(
    `${String(r.ships).padStart(5)} | ${String(r.bytes).padStart(11)} | ${r.mainUs.toFixed(1).padStart(8)} | ${r.workerUs.toFixed(1).padStart(8)} | ${r.workerUs < r.mainUs ? "worker wins" : "worker loses"}`,
  );
writeFileSync(join(OUT, "worker-bench.json"), JSON.stringify(results, null, 2));
