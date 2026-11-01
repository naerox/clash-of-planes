// Deliberately broken variants, for the "break it on purpose, then measure/observe" parts
// of Lab 1 (?exp=...) and Lab 2 (?bug=...).

import { type Ship, type World } from "@dogfight/shared";
import { rafSchedule, type FrameSchedule } from "./loop.ts";
import { createStats } from "./stats.ts";

export interface Experiment {
  readonly name: string;
  readonly block: boolean;
  readonly interval: boolean;
  readonly variable: boolean;
}

export function getExperiment(search = window.location.search): Experiment {
  const name = new URLSearchParams(search).get("exp") ?? "baseline";
  return {
    name,
    block: name === "block",
    interval: name === "interval",
    variable: name === "variable",
  };
}

export function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* spin */
  }
}

export function intervalSchedule(ms = 16): FrameSchedule {
  return (cb) => {
    const id = setInterval(() => cb(performance.now()), ms);
    return () => clearInterval(id);
  };
}

export function createVariableLoop({
  simulate,
  render,
  schedule = rafSchedule,
}: {
  simulate: (dt: number) => void;
  render: (alpha: number) => void;
  schedule?: FrameSchedule;
}) {
  const stats = createStats();
  let last: number | null = null;
  let cancel: (() => void) | null = null;

  function frame(now: number): void {
    if (last === null) last = now;
    const dt = (now - last) / 1000;
    last = now;

    const t0 = performance.now();
    simulate(dt);
    stats.countStep();
    render(1);
    stats.countFrame(now, dt * 1000, performance.now() - t0);
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

/**
 * Lab 2, Section 2's `this` bug, reproduced live and in isolation, with three fixes.
 * Open the console and load `/?bug=naive`, `/?bug=arrow`, `/?bug=bind`, or `/?bug=field`.
 *
 * We simulate `addEventListener`/`dispatchEvent` by hand (`listener.call(target, event)`)
 * instead of using a real `EventTarget`. Two reasons: (1) the DOM spec calls every
 * listener with `this` set to `currentTarget` — NOT `undefined` — so a real dispatch
 * reproduces a different, more confusing bug than the "this is undefined" story usually
 * told; our manual version keeps that real behavior. (2) a real `dispatchEvent` does NOT
 * let a listener's exception propagate to the `dispatchEvent()` call site — it's caught
 * internally and reported asynchronously (an uncaught-exception event), which would crash
 * past our `try/catch` entirely. Calling the listener ourselves keeps the demo synchronous
 * and self-contained while matching the real binding behavior exactly.
 */
export function getBugDemo(search = window.location.search): string | null {
  return new URLSearchParams(search).get("bug");
}

interface FakeEvent {
  readonly type: string;
}

/** Calls `listener` the way the DOM does: `listener.call(currentTarget, event)`. */
function dispatchLike(listener: (event: FakeEvent) => unknown, target: object, event: FakeEvent) {
  return listener.call(target, event);
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.constructor.name} — ${e.message}` : String(e);
}

export function runBugDemo(mode: string, ship: Ship, world: World): void {
  const fakeButton = { tagName: "BUTTON" }; // stand-in for the element the listener is attached to
  const fakeEvent: FakeEvent = { type: "click" };

  if (mode === "naive") {
    console.log("[bug:naive] addEventListener('click', ship.fire) — two ways this goes wrong:");

    // (a) The way the lab text puts it simplest: call the bare reference yourself, with
    // no receiver at all. Plain `f()` — rule 4, default binding — `this` is `undefined`
    // in strict mode (every ES module is strict), so `this.#cooldown` throws immediately.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- THE BUG being demonstrated
    const bareFire = ship.fire;
    try {
      bareFire(world);
      console.log("  (a) bare call: no error — unexpected");
    } catch (e: unknown) {
      console.error(`  (a) bare call, this=undefined: ${describe(e)}`);
    }

    // (b) What a REAL addEventListener actually does: the spec calls the listener as
    // `listener.call(currentTarget, event)` — so `this` is not undefined, it's the
    // button. Still wrong (the button has no #cooldown either), but a DIFFERENT error,
    // and the one you'd actually see in a browser console.
    try {
      // @ts-expect-error the compiler rejects this one on its own: a click Event is not a World
      ship.fire.call(fakeButton, fakeEvent);
      console.log("  (b) dispatched call: no error — unexpected");
    } catch (e: unknown) {
      console.error(`  (b) dispatched call, this=<button>: ${describe(e)}`);
    }
    return;
  }

  if (mode === "arrow") {
    // FIX 1: wrap the call in an arrow function. The arrow has no `this` of its own — it
    // closes over `this` from main.ts's module scope (unused here) — but critically it
    // also closes over `world` from the surrounding scope, so the mismatched-argument
    // problem below (see "bind") never arises either: the arrow ignores whatever the
    // dispatcher passes it and calls `ship.fire(world)` with the right argument itself.
    const listener = (): unknown => ship.fire(world);
    console.log("[bug:arrow] addEventListener('click', () => ship.fire(world))");
    dispatchLike(listener, fakeButton, fakeEvent);
  } else if (mode === "bind") {
    // FIX 2: `.bind(ship, world)` permanently binds BOTH `this` AND the first argument.
    // Binding only `this` (`ship.fire.bind(ship)`) is a half-fix and a real trap: the
    // dispatcher would still call the bound function with the click Event as its only
    // argument, so `world` inside `fire` would silently become that Event object instead
    // of the World — `world.spawn is not a function`. `bind`'s extra arguments exist
    // exactly for this.
    const listener = ship.fire.bind(ship, world);
    console.log("[bug:bind] addEventListener('click', ship.fire.bind(ship, world))");
    // @ts-expect-error the dispatcher's click Event lands in `fire`'s `seq` parameter — a type error
    dispatchLike(listener, fakeButton, fakeEvent);
  } else if (mode === "field") {
    // FIX 3 (not used here — shown for comparison): declaring `fire = (world) => {...}`
    // as a class field on Ship would give every SHIP INSTANCE its own bound arrow
    // function, at the cost of one extra closure allocated per ship, per method, even
    // when nothing ever passes it as a bare callback. Fine for one ship; wasteful if you
    // had thousands of entities doing this for every method "just in case".
    console.log(
      "[bug:field] would need Ship to declare `fire = (world) => {...}` as a field — skipped here, see README",
    );
    return;
  } else {
    return;
  }

  console.log(
    `[bug:${mode}] fired without throwing. bullets now:`,
    [...world.ofKind("bullet")].length,
  );
}
