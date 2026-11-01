import { createStats } from "./stats.js";

export const STEP = 1 / 60;

export function createAccumulator({ step = STEP, maxFrame = 0.25 } = {}) {
  let acc = 0;
  return {
    advance(delta, onStep) {
      acc += Math.min(Math.max(delta, 0), maxFrame);
      let n = 0;
      while (acc >= step) {
        onStep(step);
        acc -= step;
        n++;
      }
      return n;
    },
    get alpha() {
      return acc / step;
    },
  };
}

export function rafSchedule(cb) {
  let id = 0;
  const tick = (now) => {
    id = requestAnimationFrame(tick);
    cb(now);
  };
  id = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(id);
}

export function createLoop({
  step = STEP,
  maxFrame = 0.25,
  simulate,
  render,
  schedule = rafSchedule,
}) {
  const stats = createStats();
  const acc = createAccumulator({ step, maxFrame });
  let last = null;
  let cancel = null;

  function frame(now) {
    if (last === null) last = now;
    const delta = (now - last) / 1000;
    last = now;

    const t0 = performance.now();
    acc.advance(delta, (dt) => {
      simulate(dt);
      stats.countStep();
    });
    render(acc.alpha);
    stats.countFrame(now, delta * 1000, performance.now() - t0);
  }

  return {
    stats: stats.snapshot,
    start() {
      if (cancel) return;
      last = null;
      cancel = schedule(frame);
    },
    stop() {
      cancel?.();
      cancel = null;
    },
  };
}
