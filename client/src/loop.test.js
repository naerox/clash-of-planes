import test from "node:test";
import assert from "node:assert/strict";
import { createAccumulator, createLoop, STEP } from "./loop.js";

function stepsFor(frameMs, totalMs) {
  const acc = createAccumulator();
  let steps = 0;
  for (let t = 0; t < totalMs - 1e-9; t += frameMs) steps += acc.advance(frameMs / 1000, () => {});
  return steps;
}

test("simulation runs at ~60 steps per second regardless of frame rate", () => {
  for (const hz of [30, 60, 75, 120, 144, 240]) {
    const steps = stepsFor(1000 / hz, 5000);
    assert.ok(Math.abs(steps - 300) <= 1, `${hz} Hz gave ${steps} steps in 5 s`);
  }
});

test("a huge frame delta is clamped: no spiral of death", () => {
  const acc = createAccumulator();
  const steps = acc.advance(5, () => {});
  assert.equal(steps, Math.floor(0.25 / STEP));
});

test("alpha stays in [0, 1)", () => {
  const acc = createAccumulator();
  for (let i = 0; i < 1000; i++) {
    acc.advance(0.0071 + (i % 7) * 0.003, () => {});
    assert.ok(acc.alpha >= 0 && acc.alpha < 1, `alpha = ${acc.alpha}`);
  }
});

test("createLoop reports steps/s ≈ 60 and frames/s ≈ display rate (fake 144 Hz clock)", () => {
  let tick = null;
  const schedule = (cb) => {
    tick = cb;
    return () => (tick = null);
  };
  let sims = 0;
  const loop = createLoop({ simulate: () => sims++, render: () => {}, schedule });
  loop.start();
  for (let i = 0; i <= 144 * 3; i++) tick((i * 1000) / 144);
  assert.ok(Math.abs(loop.stats.stepsPerSec - 60) < 2, `steps/s = ${loop.stats.stepsPerSec}`);
  assert.ok(Math.abs(loop.stats.framesPerSec - 144) < 2, `frames/s = ${loop.stats.framesPerSec}`);
  assert.ok(Math.abs(sims - 180) <= 1, `sims = ${sims}`);
  loop.stop();
  assert.equal(tick, null);
});
