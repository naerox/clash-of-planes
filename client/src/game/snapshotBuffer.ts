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
  newAsteroid,
  newBullet,
  newShip,
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
  /** arrival − tick·STEP of the last `offsetWindow` snapshots, as a ring (no `shift()`, no spread). */
  readonly #offsets: Float64Array;
  #offsetNext = 0;
  #offsetCount = 0;
  #offsetMin = 0;
  readonly #onEvict: ((snapshot: SnapshotMessage) => void) | undefined;
  readonly capacity: number;
  readonly offsetWindow: number;
  readonly stepMs: number;
  accepted = 0;
  discarded = 0; // late or duplicate
  gaps = 0; // ticks that never arrived (loss)
  lastArrival: number | null = null;

  constructor({
    // 20 snapshots = two thirds of a second: far more than the 100–300 ms the interpolation looks
    // back. (It was 90 = three seconds, which kept ~3000 records alive long enough to be promoted
    // to the old generation, and that is what a major GC every few seconds was made of.)
    capacity = 20,
    offsetWindow = 90,
    stepMs = STEP_MS,
    onEvict,
  }: {
    capacity?: number;
    offsetWindow?: number;
    stepMs?: number;
    /** Called with every snapshot the buffer lets go of, so its records can be recycled. */
    onEvict?: (snapshot: SnapshotMessage) => void;
  } = {}) {
    this.capacity = capacity;
    this.offsetWindow = offsetWindow;
    this.stepMs = stepMs;
    this.#offsets = new Float64Array(offsetWindow);
    this.#onEvict = onEvict;
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
    if (this.#snapshots.length > this.capacity) {
      const oldest = this.#snapshots.shift();
      if (oldest) this.#onEvict?.(oldest);
    }

    this.#offsets[this.#offsetNext] = arrivalMs - snapshot.tick * this.stepMs;
    this.#offsetNext = (this.#offsetNext + 1) % this.offsetWindow;
    if (this.#offsetCount < this.offsetWindow) this.#offsetCount++;
    let min = Infinity;
    for (let i = 0; i < this.#offsetCount; i++) {
      const o = this.#offsets[i] ?? Infinity;
      if (o < min) min = o;
    }
    this.#offsetMin = min; // it only changes when a sample is added, so it is computed here, once
    this.accepted++;
    this.lastArrival = arrivalMs;
    return true;
  }

  /** server-clock − client-clock, in ms: arrival ≈ tick·STEP + offset */
  get offsetMs(): number {
    return this.#offsetCount ? this.#offsetMin : 0;
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

/**
 * Where `interpolateRemote` writes. The records and the arrays are created once and rewritten
 * every frame: at 60 fps the old version built 20–40 fresh objects (a `{ ...b }` per entity, an
 * array per kind, a `Map` per kind) 60 times a second, and the allocation profile ranked it
 * among the top allocators. Valid until the next call.
 */
export class RemoteScratch implements RemoteScene {
  readonly ships: ShipSnap[] = [];
  readonly bullets: BulletSnap[] = [];
  readonly asteroids: AsteroidSnap[] = [];
  pickups: readonly PickupSnap[] = [];

  readonly #shipRecs: ShipSnap[] = [];
  readonly #bulletRecs: BulletSnap[] = [];
  readonly #asteroidRecs: AsteroidSnap[] = [];
  readonly #lookup = new Map<EntityId, number>(); // id → index in list B; cleared and refilled, never rebuilt

  /** The held state of snapshot `a`: lists are shared, not copied (starved: nothing newer to blend toward). */
  hold(a: SnapshotMessage): this {
    this.pickups = a.pickups;
    copyList(a.ships, this.ships, this.#shipRecs, newShip, copyShip);
    copyList(a.bullets, this.bullets, this.#bulletRecs, newBullet, copyBullet);
    copyList(a.asteroids, this.asteroids, this.#asteroidRecs, newAsteroid, copyAsteroid);
    return this;
  }

  blend(a: SnapshotMessage, b: SnapshotMessage, t: number): this {
    const ticks = b.tick - a.tick;
    this.pickups = a.pickups; // they never move; one that appears or vanishes does so at a snapshot
    this.#blendShips(a.ships, b.ships, t, ticks);
    this.#blendBullets(a.bullets, b.bullets, t, ticks);
    this.#blendAsteroids(a.asteroids, b.asteroids, t, ticks);
    return this;
  }

  #index(listB: readonly Positioned[]): Map<EntityId, number> {
    this.#lookup.clear();
    for (let i = 0; i < listB.length; i++) {
      const e = listB[i];
      if (e) this.#lookup.set(e.id, i);
    }
    return this.#lookup;
  }

  #blendShips(
    listA: readonly ShipSnap[],
    listB: readonly ShipSnap[],
    t: number,
    ticks: number,
  ): void {
    const index = this.#index(listB);
    let n = 0;
    for (let i = 0; i < listA.length; i++) {
      const a = listA[i];
      if (!a) continue;
      const rec = this.#shipRecs[n] ?? (this.#shipRecs[n] = newShip());
      const j = index.get(a.id);
      const b = j === undefined ? undefined : listB[j];
      if (!b)
        copyShip(rec, a); // gone in B: keep it where it was until the render time passes B
      else if (teleported(a, b, ticks, true)) copyShip(rec, t < 0.5 ? a : b);
      else {
        copyShip(rec, b);
        rec.x = lerpWrapped(a.x, b.x, t, ARENA.width);
        rec.y = lerpWrapped(a.y, b.y, t, ARENA.height);
        rec.angle = lerpAngle(a.angle, b.angle, t);
      }
      this.ships[n++] = rec;
    }
    this.ships.length = n;
  }

  #blendBullets(
    listA: readonly BulletSnap[],
    listB: readonly BulletSnap[],
    t: number,
    ticks: number,
  ): void {
    const index = this.#index(listB);
    let n = 0;
    for (let i = 0; i < listA.length; i++) {
      const a = listA[i];
      if (!a) continue;
      const rec = this.#bulletRecs[n] ?? (this.#bulletRecs[n] = newBullet());
      const j = index.get(a.id);
      const b = j === undefined ? undefined : listB[j];
      if (!b) copyBullet(rec, a);
      else if (teleported(a, b, ticks, false)) copyBullet(rec, t < 0.5 ? a : b);
      else {
        copyBullet(rec, b);
        rec.x = lerp(a.x, b.x, t);
        rec.y = lerp(a.y, b.y, t);
      }
      this.bullets[n++] = rec;
    }
    this.bullets.length = n;
  }

  #blendAsteroids(
    listA: readonly AsteroidSnap[],
    listB: readonly AsteroidSnap[],
    t: number,
    ticks: number,
  ): void {
    const index = this.#index(listB);
    let n = 0;
    for (let i = 0; i < listA.length; i++) {
      const a = listA[i];
      if (!a) continue;
      const rec = this.#asteroidRecs[n] ?? (this.#asteroidRecs[n] = newAsteroid());
      const j = index.get(a.id);
      const b = j === undefined ? undefined : listB[j];
      if (!b) copyAsteroid(rec, a);
      else if (teleported(a, b, ticks, false)) copyAsteroid(rec, t < 0.5 ? a : b);
      else {
        copyAsteroid(rec, b);
        rec.x = lerp(a.x, b.x, t);
        rec.y = lerp(a.y, b.y, t);
        rec.angle = lerpAngle(a.angle, b.angle, t);
      }
      this.asteroids[n++] = rec;
    }
    this.asteroids.length = n;
  }
}

function copyList<E>(
  from: readonly E[],
  into: E[],
  recs: E[],
  make: () => E,
  copy: (dst: E, src: E) => void,
): void {
  for (let i = 0; i < from.length; i++) {
    const src = from[i];
    if (!src) continue;
    const rec = recs[i] ?? (recs[i] = make());
    copy(rec, src);
    into[i] = rec;
  }
  into.length = from.length;
}

function copyShip(d: ShipSnap, s: ShipSnap): void {
  d.id = s.id;
  d.x = s.x;
  d.y = s.y;
  d.angle = s.angle;
  d.hp = s.hp;
  d.thrusting = s.thrusting;
  d.dead = s.dead;
  d.rapid = s.rapid;
  d.score = s.score;
}
function copyBullet(d: BulletSnap, s: BulletSnap): void {
  d.id = s.id;
  d.owner = s.owner;
  d.x = s.x;
  d.y = s.y;
  d.seq = s.seq;
}
function copyAsteroid(d: AsteroidSnap, s: AsteroidSnap): void {
  d.id = s.id;
  d.x = s.x;
  d.y = s.y;
  d.angle = s.angle;
  d.radius = s.radius;
  d.hunter = s.hunter;
}

/**
 * The remote part of the scene at one render instant. Returns `out` (rewritten), or — when no
 * `out` is given, as in the tests — a fresh scratch.
 */
export function interpolateRemote(
  { a, b, t }: Pick<Sample, "a" | "b" | "t">,
  out: RemoteScratch = new RemoteScratch(),
): RemoteScene {
  return b ? out.blend(a, b, t) : out.hold(a);
}
