// Entity interpolation (Lab 5, §4). Other players arrive as 30 discrete states a second but we
// draw at 60–144 Hz. Drawing the newest state gives 30 Hz stutter, so remote entities are drawn
// in the PAST: `interpolationDelay` ms behind the newest data, always between two snapshots we
// already have.
//
// Two small problems on the way:
//
//  1. WHICH time is "now" on the server? The arrival times of snapshots jitter, so they make a
//     poor clock. Every snapshot carries its TICK, and ticks are exactly STEP_MS apart on the
//     server's own clock. So we estimate ONE number, the offset between the server's tick clock
//     and ours, and read time from ticks. The offset is the MINIMUM of (arrival − tick·STEP)
//     over the last few seconds: the fastest packets are the ones that experienced no queueing,
//     so they are the best estimate of the real link; slower ones are "late", and the
//     interpolation delay is exactly the headroom that absorbs their lateness.
//  2. Lost or reordered snapshots. Ticks have gaps when packets are dropped: interpolation
//     simply spans the gap (the bracketing snapshots may be 2–3 ticks apart). A snapshot older
//     than one we have already seen is thrown away.

import { STEP_MS, ARENA, lerp, angleDelta, wrappedDelta, wrap } from "@dogfight/shared";

export class SnapshotBuffer {
  #snapshots = [];
  #offsets = [];

  constructor({ capacity = 90, offsetWindow = 90, stepMs = STEP_MS } = {}) {
    this.capacity = capacity;
    this.offsetWindow = offsetWindow;
    this.stepMs = stepMs;
    this.accepted = 0;
    this.discarded = 0; // late or duplicate
    this.gaps = 0; // ticks that never arrived (loss)
    this.lastArrival = null;
  }

  get latest() {
    return this.#snapshots.at(-1) ?? null;
  }

  get size() {
    return this.#snapshots.length;
  }

  /** @returns {boolean} false if the snapshot was older than (or equal to) the newest one */
  push(snapshot, arrivalMs) {
    const newest = this.latest;
    if (newest && snapshot.tick <= newest.tick) {
      this.discarded++;
      return false;
    }
    if (newest) this.gaps += snapshot.tick - newest.tick - 1;
    this.#snapshots.push(snapshot);
    if (this.#snapshots.length > this.capacity) this.#snapshots.shift();

    this.#offsets.push(arrivalMs - snapshot.tick * this.stepMs);
    if (this.#offsets.length > this.offsetWindow) this.#offsets.shift();
    this.accepted++;
    this.lastArrival = arrivalMs;
    return true;
  }

  /** server-clock − client-clock, in ms: arrival ≈ tick·STEP + offset */
  get offsetMs() {
    return this.#offsets.length ? Math.min(...this.#offsets) : 0;
  }

  /** The (fractional) server tick that should be on screen at client time `nowMs`. */
  renderTick(nowMs, delayMs) {
    return (nowMs - delayMs - this.offsetMs) / this.stepMs;
  }

  /**
   * The two snapshots around `renderTick`, and how far between them we are (0..1).
   * `starved` = we ran out of future: the render time is beyond the newest snapshot, so the
   * last known state is held (never extrapolated — a guess would be worse than a pause).
   */
  sample(renderTick) {
    const all = this.#snapshots;
    if (all.length === 0) return null;
    if (renderTick >= all.at(-1).tick) return { a: all.at(-1), b: null, t: 0, starved: true };
    if (renderTick <= all[0].tick)
      return { a: all[0], b: all.length > 1 ? all[1] : null, t: 0, starved: false };
    let i = all.length - 2;
    while (i > 0 && all[i].tick > renderTick) i--;
    const a = all[i];
    const b = all[i + 1];
    return { a, b, t: (renderTick - a.tick) / (b.tick - a.tick), starved: false };
  }
}

// ── interpolating the entity lists ─────────────────────────────────────────────────────

const lerpAngle = (a, b, t) => a + angleDelta(a, b) * t;
const lerpWrapped = (a, b, t, size) => wrap(a + wrappedDelta(a, b, size) * t, size);

/** An entity that moved further than any real entity can in the time between two snapshots
 * teleported (respawn, a pickup reappearing under a reused id): do not draw a streak across the arena. */
function teleported(from, to, ticks, wraps) {
  const dx = wraps ? wrappedDelta(from.x, to.x, ARENA.width) : to.x - from.x;
  const dy = wraps ? wrappedDelta(from.y, to.y, ARENA.height) : to.y - from.y;
  const fastest = 1000; // units/s: a bullet fired forward from a full-speed ship is ~900
  return Math.hypot(dx, dy) > (fastest * ticks) / 30 + 60;
}

function blend(listA, listB, t, ticks, { wraps, angle }) {
  const byId = new Map(listB.map((e) => [e.id, e]));
  const out = [];
  for (const a of listA) {
    const b = byId.get(a.id);
    // present in A, gone in B: it died/expired somewhere in this interval — keep it where it was
    // until the render time passes B (then it is simply no longer in the list)
    if (!b) {
      out.push(a);
      continue;
    }
    if (teleported(a, b, ticks, wraps)) {
      out.push(t < 0.5 ? a : b);
      continue;
    }
    const merged = { ...b };
    merged.x = wraps ? lerpWrapped(a.x, b.x, t, ARENA.width) : lerp(a.x, b.x, t);
    merged.y = wraps ? lerpWrapped(a.y, b.y, t, ARENA.height) : lerp(a.y, b.y, t);
    if (angle) merged.angle = lerpAngle(a.angle, b.angle, t);
    out.push(merged);
  }
  // present in B only: it has not been "born" yet at this render time — it appears when the
  // render time reaches B, where it becomes part of the next interval's A list
  return out;
}

/**
 * The remote part of the scene at one render instant.
 * @param {{a: object, b: object|null, t: number}} sample from SnapshotBuffer.sample
 */
export function interpolateRemote({ a, b, t }) {
  if (!b) {
    return { ships: a.ships, bullets: a.bullets, asteroids: a.asteroids, pickups: a.pickups };
  }
  const ticks = b.tick - a.tick;
  return {
    ships: blend(a.ships, b.ships, t, ticks, { wraps: true, angle: true }),
    bullets: blend(a.bullets, b.bullets, t, ticks, { wraps: false, angle: false }),
    asteroids: blend(a.asteroids, b.asteroids, t, ticks, { wraps: false, angle: true }),
    pickups: a.pickups, // they never move; one that appears or vanishes does so at a snapshot
  };
}
