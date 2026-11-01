// shared/src runs in a browser AND in Node. That only works if it uses nothing that exists in
// just one of them — and nothing nondeterministic. This test reads the source and fails on
// any of the forbidden names, so a careless `Math.random()` or `Date.now()` cannot slip in.

import { test } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "../src");

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(p);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) yield p;
  }
}

const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
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
  const checked: string[] = [];
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
  assert.ok(!("window" in globalThis));
  assert.ok(!("document" in globalThis));
  for (const file of files(SRC)) await import(file);
  const shared = await import("../src/index.ts");
  assert.equal(typeof shared.World, "function");
  assert.equal(typeof shared.binaryCodec.encode, "function");
});

// zod is the one allowed dependency: it is pure JavaScript that runs in a browser and in Node.
const ALLOWED_PACKAGES = new Set(["zod"]);

test("shared/src imports only relative modules and zod", () => {
  for (const file of files(SRC)) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const match of code.matchAll(/from\s+["']([^"']+)["']/g)) {
      const spec = match[1] ?? "";
      assert.ok(
        spec.startsWith(".") || ALLOWED_PACKAGES.has(spec),
        `${file.slice(SRC.length)} imports "${spec}"`,
      );
    }
  }
});
