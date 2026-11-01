// A timer as a plain function: `schedule(fn, ms)` runs `fn` later and returns a function that
// cancels it. Injectable, so tests can drive time by hand — and, unlike passing
// `setTimeout`/`clearTimeout` around, it needs no timer-handle type at all.

export type Schedule = (fn: () => void, ms: number) => () => void;

export const realSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/** Like `realSchedule`, but the pending timer never keeps the process alive. */
export const unrefSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};
