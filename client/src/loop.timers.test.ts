// The game loop driven by fake timers: Vitest's clock stands in for requestAnimationFrame, so a
// "10 second" session runs in milliseconds and the result is exact.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { STEP, createLoop, type FrameSchedule } from "./loop.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A frame source at `hz`: calls back with `performance.now()`, like rAF does. */
const framesAt =
  (hz: number): FrameSchedule =>
  (cb) => {
    const id = setInterval(() => cb(performance.now()), 1000 / hz);
    return () => clearInterval(id);
  };

describe("createLoop on a fake clock", () => {
  test.each([30, 60, 144])("at %i fps the simulation still runs 60 steps per second", (hz) => {
    let steps = 0;
    const loop = createLoop({ simulate: () => steps++, render: () => {}, schedule: framesAt(hz) });
    loop.start();
    vi.advanceTimersByTime(10_000);
    loop.stop();
    expect(Math.abs(steps - 600)).toBeLessThanOrEqual(6); // 1%: fake timers tick in whole ms
  });

  test("a frame that arrives 2 s late runs at most maxFrame worth of steps (no spiral of death)", () => {
    let steps = 0;
    const loop = createLoop({ simulate: () => steps++, render: () => {}, schedule: framesAt(60) });
    loop.start();
    vi.advanceTimersByTime(100);
    const before = steps;
    vi.setSystemTime(Date.now() + 2000); // the tab was frozen
    vi.advanceTimersByTime(17);
    expect(steps - before).toBeLessThanOrEqual(Math.ceil(0.25 / STEP) + 1);
    loop.stop();
  });

  test("render gets an interpolation factor in [0, 1) on every frame", () => {
    const alphas: number[] = [];
    const loop = createLoop({
      simulate: () => {},
      render: (a) => alphas.push(a),
      schedule: framesAt(144),
    });
    loop.start();
    vi.advanceTimersByTime(2000);
    loop.stop();
    expect(alphas.length).toBeGreaterThan(250);
    expect(alphas.every((a) => a >= 0 && a < 1)).toBe(true);
  });

  test("stop() stops: no more steps, and start() after stop() begins afresh", () => {
    let steps = 0;
    const loop = createLoop({ simulate: () => steps++, render: () => {}, schedule: framesAt(60) });
    loop.start();
    vi.advanceTimersByTime(1000);
    loop.stop();
    const stopped = steps;
    vi.advanceTimersByTime(1000);
    expect(steps).toBe(stopped);
    loop.start();
    vi.advanceTimersByTime(1000);
    expect(steps).toBeGreaterThan(stopped + 50);
    loop.stop();
  });
});
