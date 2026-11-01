// What `GameSession.render` hands to the canvas: plain data, already interpolated/predicted.

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
