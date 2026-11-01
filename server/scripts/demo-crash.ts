// Why an "error" event with no listener takes the whole process down (Lab 4, M4).
//
//   node scripts/demo-crash.ts bare       an emitter that emits "error" and nobody listens
//   node scripts/demo-crash.ts stream     the real-world version: a log file in a missing directory
//   node scripts/demo-crash.ts rejection  the promise-shaped twin: an unhandled rejection
//   node scripts/demo-crash.ts fixed      the same three, handled — the process survives
//
// Every mode keeps a timer running ("server is alive"); watch it stop in the crashing ones.

import { errorCode } from "./common.ts";
import { EventEmitter } from "node:events";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const mode = process.argv[2] ?? "bare";
const alive = setInterval(() => console.log("  … server is alive"), 200);
setTimeout(() => {
  console.log("  survived: shutting down normally");
  clearInterval(alive);
}, 700);

console.log(`mode: ${mode}`);

if (mode === "bare") {
  setTimeout(() => new EventEmitter().emit("error", new Error("boom")), 300);
} else if (mode === "stream") {
  // LOG_DIR does not exist; nothing listens for the stream's "error" event
  setTimeout(() => createWriteStream("/no/such/dir/match.ndjson"), 300);
} else if (mode === "rejection") {
  setTimeout(() => Promise.reject(new Error("a rejected promise nobody awaited")), 300);
} else if (mode === "fixed") {
  setTimeout(() => {
    const emitter = new EventEmitter();
    emitter.on("error", (err) => console.log(`  handled emitter error: ${err.message}`));
    emitter.emit("error", new Error("boom"));

    createWriteStream("/no/such/dir/match.ndjson").on("error", (err) =>
      console.log(`  handled stream error: ${errorCode(err)}`),
    );

    pipeline(Readable.from(["x"]), createWriteStream("/no/such/dir/match.ndjson")).catch((err) =>
      console.log(`  handled pipeline rejection: ${errorCode(err)}`),
    );
  }, 300);
} else {
  console.error("unknown mode");
  process.exit(2);
}
