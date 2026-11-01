// Notes experiment 4 (Lab 4): a fast producer, a slow consumer, and what rss does.
//   node scripts/exp-backpressure.js pipeline   — stream.pipeline: bounded, runs 4 s then stops
//   node scripts/exp-backpressure.js naive      — a loop that ignores write()'s return value
// The naive loop is capped at 3000 chunks (≈ 190 MB) so it cannot hurt the machine; without
// the cap it would simply keep going until the process died.

import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const mode = process.argv[2] ?? "pipeline";
const CHUNK = 64 * 1024;
const rss = () => `${(process.memoryUsage.rss() / 1048576).toFixed(0)} MB`;

let written = 0;
const slow = new Writable({
  write(_chunk, _enc, callback) {
    written++;
    setTimeout(callback, 100); // a consumer that needs 100 ms per chunk (≈ 0.6 MB/s)
  },
});

console.log(`${mode}: start, rss ${rss()}`);

if (mode === "pipeline") {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 4000);
  const ticker = setInterval(
    () =>
      console.log(
        `  t+${(performance.now() / 1000).toFixed(1)}s  rss ${rss()}  consumed ${written} chunks`,
      ),
    1000,
  );
  const source = Readable.from(
    (function* () {
      for (;;) yield Buffer.alloc(CHUNK); // endless
    })(),
  );
  await pipeline(source, slow, { signal: ac.signal }).catch((err) => {
    if (err.name !== "AbortError") throw err;
  });
  clearInterval(ticker);
} else if (mode === "naive") {
  let backed = 0;
  for (let i = 0; i < 3000; i++) {
    if (!slow.write(Buffer.alloc(CHUNK))) backed++; // `false` means "stop" — ignored here
    if (i % 500 === 0)
      console.log(
        `  chunk ${i}  rss ${rss()}  writable buffer ${(slow.writableLength / 1048576).toFixed(0)} MB`,
      );
  }
  console.log(`  write() returned false ${backed} times and we kept writing`);
  console.log(
    `  after the loop: rss ${rss()}, writable buffer ${(slow.writableLength / 1048576).toFixed(0)} MB, consumed ${written} chunks`,
  );
  slow.destroy();
}
console.log(`${mode}: end, rss ${rss()}`);
process.exit(0);
