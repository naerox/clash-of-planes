import test from "node:test";
import assert from "node:assert/strict";
import { PUZZLES, runPuzzle } from "./puzzles.js";

// Node has no requestAnimationFrame, so puzzle 4 is checked in the browser (/?puzzles);
// the other four have the same answer in Node and in Chrome.
for (const p of PUZZLES.filter((p) => !p.title.includes("requestAnimationFrame"))) {
  test(`puzzle ${p.title}`, async () => {
    assert.deepEqual(await runPuzzle(p, 20), p.expected);
  });
}
