// Experiment 4 of the notes: sending 50 MB to a Worker by structured CLONE vs by TRANSFER.
// What matters is how long the sender's (main) thread is blocked inside `postMessage`.
//   node tools/lab07/transfer-bench.ts
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const page = await browser.newPage();
const rows = await page.evaluate(async () => {
  const worker = new Worker(
    URL.createObjectURL(
      new Blob(["onmessage = (e) => postMessage(e.data.byteLength)"], { type: "text/javascript" }),
    ),
  );
  const reply = () => new Promise<void>((r) => (worker.onmessage = () => r()));
  const out: { variant: string; blockedMs: number; roundTripMs: number; sourceAfter: number }[] =
    [];
  for (const variant of ["clone", "transfer"]) {
    const samples: number[] = [];
    const trips: number[] = [];
    let sourceAfter = 0;
    for (let i = 0; i < 5; i++) {
      const buffer = new ArrayBuffer(50 * 1024 * 1024);
      new Uint8Array(buffer)[0] = 1; // touch it
      const done = reply();
      const t0 = performance.now();
      if (variant === "clone") worker.postMessage(buffer);
      else worker.postMessage(buffer, [buffer]);
      samples.push(performance.now() - t0);
      sourceAfter = buffer.byteLength; // 0 after a transfer: the sender no longer owns it
      await done;
      trips.push(performance.now() - t0);
    }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
    out.push({ variant, blockedMs: med(samples), roundTripMs: med(trips), sourceAfter });
  }
  worker.terminate();
  return out;
});
await browser.close();
console.log("50 MB ArrayBuffer to a Worker (median of 5)");
console.log(
  "variant   | main thread blocked in postMessage | until the worker answered | buffer.byteLength afterwards",
);
for (const r of rows)
  console.log(
    `${r.variant.padEnd(9)} | ${r.blockedMs.toFixed(2).padStart(30)} ms | ${r.roundTripMs.toFixed(2).padStart(21)} ms | ${r.sourceAfter}`,
  );
