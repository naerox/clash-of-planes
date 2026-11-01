// Recycling snapshot objects. A decoded snapshot is ~30 small objects (a record per ship, bullet,
// asteroid and pickup) that arrive 30 times a second and are needed for a fraction of a second.
// Left to the garbage collector, the ones that happen to survive two scavenges get promoted to
// the old generation and die there — which is what makes a MAJOR collection happen every few
// seconds in a game whose live data is a few megabytes.
//
// So the client keeps them: `release(snapshot)` puts a finished snapshot's records on free lists,
// and the decoder takes records from there. After a few seconds there is nothing left to allocate.
// (Typed arrays would be the next step — see the README — but records keep every consumer's code
// and every test as it was.)

import type { EntityId, Seq, Tick } from "../brand.ts";
import { entityId, seq, shotSeq, tick } from "../brand.ts";
import type {
  AsteroidSnap,
  BulletSnap,
  PickupSnap,
  ShipSnap,
  SnapshotMessage,
} from "../protocol.ts";
import type { ShipState } from "../sim/ship.ts";

/** The same type with its `readonly` removed: a pooled record is rewritten, not rebuilt. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const NO_ID: EntityId = entityId(0);
const NO_TICK: Tick = tick(0);
const NO_SEQ: Seq = seq(0);

export const newShip = (): ShipSnap => ({
  kind: "ship",
  id: NO_ID,
  x: 0,
  y: 0,
  angle: 0,
  hp: 0,
  thrusting: false,
  dead: false,
  rapid: false,
  score: 0,
});
export const newBullet = (): BulletSnap => ({
  kind: "bullet",
  id: NO_ID,
  owner: NO_ID,
  x: 0,
  y: 0,
  seq: shotSeq(0),
});
export const newAsteroid = (): AsteroidSnap => ({
  kind: "asteroid",
  id: NO_ID,
  x: 0,
  y: 0,
  angle: 0,
  radius: 0,
  hunter: false,
});
export const newPickup = (): PickupSnap => ({
  kind: "pickup",
  id: NO_ID,
  x: 0,
  y: 0,
  variant: "shield",
});
const newState = (): Mutable<ShipState> => ({
  id: NO_ID,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  angle: 0,
  hp: 0,
  cooldown: 0,
  rapid: 0,
  respawn: 0,
  score: 0,
  thrusting: false,
});
export const newSnapshot = (): SnapshotMessage => ({
  type: "snapshot",
  tick: NO_TICK,
  ack: NO_SEQ,
  you: null,
  ships: [],
  bullets: [],
  asteroids: [],
  pickups: [],
  events: [],
});

export class SnapshotRecycler {
  readonly #messages: SnapshotMessage[] = [];
  readonly #ships: ShipSnap[] = [];
  readonly #bullets: BulletSnap[] = [];
  readonly #asteroids: AsteroidSnap[] = [];
  readonly #pickups: PickupSnap[] = [];
  readonly #states: Mutable<ShipState>[] = [];
  /** How many records had to be created because a free list was empty (it stops growing once warm). */
  created = 0;

  /** An empty snapshot (its arrays have length 0). */
  message(): SnapshotMessage {
    const m = this.#messages.pop();
    if (m) return m;
    this.created++;
    return newSnapshot();
  }
  ship(): ShipSnap {
    return this.#ships.pop() ?? (this.created++, newShip());
  }
  bullet(): BulletSnap {
    return this.#bullets.pop() ?? (this.created++, newBullet());
  }
  asteroid(): AsteroidSnap {
    return this.#asteroids.pop() ?? (this.created++, newAsteroid());
  }
  pickup(): PickupSnap {
    return this.#pickups.pop() ?? (this.created++, newPickup());
  }
  state(): Mutable<ShipState> {
    return this.#states.pop() ?? (this.created++, newState());
  }

  /** The snapshot is finished with: its records go back on the free lists. Do not touch it afterwards. */
  release(m: SnapshotMessage): void {
    for (const s of m.ships) this.#ships.push(s);
    for (const b of m.bullets) this.#bullets.push(b);
    for (const a of m.asteroids) this.#asteroids.push(a);
    for (const p of m.pickups) this.#pickups.push(p);
    // `you` came from `state()`, so it is safe to write to again
    if (m.you) this.#states.push(m.you);
    m.ships.length = 0;
    m.bullets.length = 0;
    m.asteroids.length = 0;
    m.pickups.length = 0;
    m.events.length = 0;
    m.you = null;
    this.#messages.push(m);
  }
}
