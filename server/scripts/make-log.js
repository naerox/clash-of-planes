// Generates a synthetic match log (NDJSON) of a given size, for the backpressure experiment.
//   node scripts/make-log.js <file> [megabytes=200]
// It is itself a stream pipeline — Readable.from(generator) → write stream — so producing
// 200 MB never holds more than a few chunks in memory.

import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const [file, mb = "200"] = process.argv.slice(2);
if (!file) {
  console.error("usage: node scripts/make-log.js <file> [megabytes]");
  process.exit(2);
}
const target = Number(mb) * 1024 * 1024;
const names = ["Ace", "Bob", "Cy", "Dana", "Eve", "Фокс", "Мрія"];
const words = [
  "bank",
  "left",
  "target",
  "fire",
  "cover",
  "fuel",
  "ahead",
  "behind",
  "ok",
  "gg",
  "привіт",
  "ціль",
];

function* lines() {
  let bytes = 0;
  let t = 1_700_000_000_000;
  let i = 0;
  while (bytes < target) {
    const name = names[i % names.length];
    const text = Array.from(
      { length: 3 + (i % 8) },
      (_, k) => words[(i * 7 + k * 3) % words.length],
    ).join(" ");
    const event =
      i % 5 === 0
        ? { t, room: "belt-ab12", type: "chat", player: `p${i % 7}`, name, text }
        : {
            t,
            room: "belt-ab12",
            type: "hit",
            player: `p${i % 7}`,
            target: `a${i % 11}`,
            damage: 12,
          };
    const line = `${JSON.stringify(event)}\n`;
    bytes += Buffer.byteLength(line);
    t += 16 + (i % 5);
    i++;
    yield line;
  }
}

await pipeline(Readable.from(lines()), createWriteStream(file));
console.log(`wrote ${file}`);
