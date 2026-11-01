// shared/src runs in a browser AND in Node. That only works if it uses nothing that exists in
// just one of them — and nothing nondeterministic. This test reads the source and fails on
// any of the forbidden names, so a careless `Math.random()` or `Date.now()` cannot slip in.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "../src");

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(p);
    else if (entry.name.endsWith(".js")) yield p;
  }
}

const stripComments = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const FORBIDDEN = [
  [/Math\.random/, "Math.random() — use the seeded Rng"],
  [/Date\.now|new Date\b|\bDate\(/, "the wall clock"],
  [/\bperformance\b/, "performance.now()"],
  [/\b(setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame)\b/, "timers"],
  [/\bwindow\b|\bdocument\b|\bnavigator\b|\blocalStorage\b/, "browser globals"],
  [/\bprocess\b|\bBuffer\b|\brequire\s*\(|__dirname|__filename/, "Node globals"],
  [/from\s+["']node:/, "a Node built-in module"],
  [/\bconsole\b/, "console"],
  [/\bcrypto\b/, "crypto (a source of randomness)"],
];

test("no file under shared/src uses a clock, a timer, randomness, the DOM or Node", () => {
  const checked = [];
  for (const file of files(SRC)) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const [pattern, what] of FORBIDDEN) {
      assert.ok(!pattern.test(code), `${file.slice(SRC.length)} uses ${what}`);
    }
    checked.push(file);
  }
  assert.ok(checked.length >= 15, `scanned ${checked.length} files`);
});

test("every module imports cleanly in plain Node with no DOM (and without `window`)", async () => {
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(typeof globalThis.document, "undefined");
  for (const file of files(SRC)) await import(file);
  const shared = await import("../src/index.js");
  assert.equal(typeof shared.World, "function");
  assert.equal(typeof shared.binaryCodec.encode, "function");
});

test("the only imports inside shared/src are relative: it depends on nothing", () => {
  for (const file of files(SRC)) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const [, spec] of code.matchAll(/from\s+["']([^"']+)["']/g)) {
      assert.ok(spec.startsWith("."), `${file.slice(SRC.length)} imports "${spec}"`);
    }
  }
});
