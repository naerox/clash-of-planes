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

import {
  STEP_MS,
  ARENA,
  lerp,
  angleDelta,
  wrappedDelta,
  wrap,
  type AsteroidSnap,
  type BulletSnap,
  type EntityId,
  type PickupSnap,
  type ShipSnap,
  type SnapshotMessage,
} from "@dogfight/shared";

/** Where the newest data is relative to the render time: the two snapshots to blend, and how far. */
export interface Sample {
  readonly a: SnapshotMessage;
  readonly b: SnapshotMessage | null;
  readonly t: number;
  readonly starved: boolean;
}

/** The entities other players (and the world) contribute to a frame. */
export interface RemoteScene {
  readonly ships: readonly ShipSnap[];
  readonly bullets: readonly BulletSnap[];
  readonly asteroids: readonly AsteroidSnap[];
  readonly pickups: readonly PickupSnap[];
}

export class SnapshotBuffer {
  #snapshots: SnapshotMessage[] = [];
  #offsets: number[] = [];
  readonly capacity: number;
  readonly offsetWindow: number;
  readonly stepMs: number;
  accepted = 0;
  discarded = 0; // late or duplicate
  gaps = 0; // ticks that never arrived (loss)
  lastArrival: number | null = null;

  constructor({
    capacity = 90,
    offsetWindow = 90,
    stepMs = STEP_MS,
  }: { capacity?: number; offsetWindow?: number; stepMs?: number } = {}) {
    this.capacity = capacity;
    this.offsetWindow = offsetWindow;
    this.stepMs = stepMs;
  }

  get latest(): SnapshotMessage | null {
    return this.#snapshots.at(-1) ?? null;
  }

  get size(): number {
    return this.#snapshots.length;
  }

  /** @returns false if the snapshot was older than (or equal to) the newest one */
  push(snapshot: SnapshotMessage, arrivalMs: number): boolean {
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
  get offsetMs(): number {
    return this.#offsets.length ? Math.min(...this.#offsets) : 0;
  }

  /** The (fractional) server tick that should be on screen at client time `nowMs`. */
  renderTick(nowMs: number, delayMs: number): number {
    return (nowMs - delayMs - this.offsetMs) / this.stepMs;
  }

  /**
   * The two snapshots around `renderTick`, and how far between them we are (0..1).
   * `starved` = we ran out of future: the render time is beyond the newest snapshot, so the
   * last known state is held (never extrapolated — a guess would be worse than a pause).
   */
  sample(renderTick: number): Sample | null {
    const all = this.#snapshots;
    const first = all[0];
    const last = all.at(-1);
    if (!first || !last) return null;
    if (renderTick >= last.tick) return { a: last, b: null, t: 0, starved: true };
    if (renderTick <= first.tick) return { a: first, b: all[1] ?? null, t: 0, starved: false };
    let i = all.length - 2;
    while (i > 0 && (all[i]?.tick ?? 0) > renderTick) i--;
    const a = all[i];
    const b = all[i + 1];
    if (!a || !b) return { a: last, b: null, t: 0, starved: true };
    return { a, b, t: (renderTick - a.tick) / (b.tick - a.tick), starved: false };
  }
}

// ── interpolating the entity lists ─────────────────────────────────────────────────────

const lerpAngle = (a: number, b: number, t: number): number => a + angleDelta(a, b) * t;
const lerpWrapped = (a: number, b: number, t: number, size: number): number =>
  wrap(a + wrappedDelta(a, b, size) * t, size);

interface Positioned {
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
}

/** An entity that moved further than any real entity can in the time between two snapshots
 * teleported (respawn, a pickup reappearing under a reused id): do not draw a streak across the arena. */
function teleported(from: Positioned, to: Positioned, ticks: number, wraps: boolean): boolean {
  const dx = wraps ? wrappedDelta(from.x, to.x, ARENA.width) : to.x - from.x;
  const dy = wraps ? wrappedDelta(from.y, to.y, ARENA.height) : to.y - from.y;
  const fastest = 1000; // units/s: a bullet fired forward from a full-speed ship is ~900
  return Math.hypot(dx, dy) > (fastest * ticks) / 30 + 60;
}

function blend<E extends Positioned>(
  listA: readonly E[],
  listB: readonly E[],
  t: number,
  ticks: number,
  wraps: boolean,
  turn: (a: E, b: E, t: number) => Partial<E> = () => ({}),
): E[] {
  const byId = new Map(listB.map((e) => [e.id, e]));
  const out: E[] = [];
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
    out.push({
      ...b,
      x: wraps ? lerpWrapped(a.x, b.x, t, ARENA.width) : lerp(a.x, b.x, t),
      y: wraps ? lerpWrapped(a.y, b.y, t, ARENA.height) : lerp(a.y, b.y, t),
      ...turn(a, b, t),
    });
  }
  // present in B only: it has not been "born" yet at this render time — it appears when the
  // render time reaches B, where it becomes part of the next interval's A list
  return out;
}

/**
 * The remote part of the scene at one render instant.
 */
export function interpolateRemote({ a, b, t }: Pick<Sample, "a" | "b" | "t">): RemoteScene {
  if (!b) {
    return { ships: a.ships, bullets: a.bullets, asteroids: a.asteroids, pickups: a.pickups };
  }
  const ticks = b.tick - a.tick;
  return {
    ships: blend(a.ships, b.ships, t, ticks, true, (p, q, k) => ({
      angle: lerpAngle(p.angle, q.angle, k),
    })),
    bullets: blend(a.bullets, b.bullets, t, ticks, false),
    asteroids: blend(a.asteroids, b.asteroids, t, ticks, false, (p, q, k) => ({
      angle: lerpAngle(p.angle, q.angle, k),
    })),
    pickups: a.pickups, // they never move; one that appears or vanishes does so at a snapshot
  };
}
