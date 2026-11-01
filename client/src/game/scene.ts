// What `GameSession.render` hands to the canvas: plain data, already interpolated/predicted.

import { entityId, shotSeq } from "@dogfight/shared";
import type { AsteroidSnap, EntityId, PickupSnap, ShotSeq } from "@dogfight/shared";

export interface DrawShip {
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly thrusting: boolean;
  readonly dead: boolean;
  readonly hp: number;
  readonly score: number;
  readonly rapid: boolean;
  readonly isMe: boolean;
  readonly name: string;
  /** Seconds until the local ship respawns (only known for our own). */
  readonly respawn?: number;
}

/** A bullet to draw. `id` is the server's, or a local one for a shot the server has not echoed yet. */
export interface DrawBullet {
  readonly id: number;
  readonly owner: EntityId;
  readonly x: number;
  readonly y: number;
  readonly seq: ShotSeq;
}

export interface Scene {
  readonly ships: readonly DrawShip[];
  readonly me: DrawShip | null;
  readonly bullets: readonly DrawBullet[];
  readonly asteroids: readonly AsteroidSnap[];
  readonly pickups: readonly PickupSnap[];
  readonly starved: boolean;
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

const blankShip = (): Writable<DrawShip> => ({
  id: entityId(0),
  x: 0,
  y: 0,
  angle: 0,
  thrusting: false,
  dead: false,
  hp: 0,
  score: 0,
  rapid: false,
  isMe: false,
  name: "",
  respawn: 0,
});
const blankBullet = (): Writable<DrawBullet> => ({
  id: 0,
  owner: entityId(0),
  x: 0,
  y: 0,
  seq: shotSeq(0),
});

/**
 * A scene that is rewritten every frame instead of rebuilt: the records and arrays are created
 * once and grow only to the largest scene seen. `GameSession.render` fills one; the result is valid
 * until the next call with the same scratch (the renderer draws it at once and keeps nothing).
 * Tests and tools call `render` without one and get a fresh, independent scene.
 */
export class SceneScratch implements Scene {
  readonly ships: DrawShip[] = [];
  readonly bullets: DrawBullet[] = [];
  asteroids: readonly AsteroidSnap[] = [];
  pickups: readonly PickupSnap[] = [];
  me: DrawShip | null = null;
  starved = true;

  readonly #shipRecs: Writable<DrawShip>[] = [];
  readonly #bulletRecs: Writable<DrawBullet>[] = [];
  readonly #meRec = blankShip();

  /** The i-th ship record, ready to be overwritten and appended with `this.ships.length = n`. */
  shipAt(i: number): Writable<DrawShip> {
    return this.#shipRecs[i] ?? (this.#shipRecs[i] = blankShip());
  }
  bulletAt(i: number): Writable<DrawBullet> {
    return this.#bulletRecs[i] ?? (this.#bulletRecs[i] = blankBullet());
  }
  /** Our own ship's record (kept apart from the others). */
  get meRecord(): Writable<DrawShip> {
    return this.#meRec;
  }
}
