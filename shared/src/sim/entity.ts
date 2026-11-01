import { entityId, type EntityId } from "../brand.ts";
import type { Homing } from "./homing.ts";
import { Vector2 } from "./vector.ts";

export type EntityKind = "ship" | "bullet" | "asteroid" | "pickup";

/**
 * Base class for everything that lives in the World: ships, bullets, asteroids, pickups.
 * Deliberately thin — position, velocity, a collision radius, and an `update(dt)` that just
 * moves it. Anything more specific (HP, TTL, homing) is added either by a one-level subclass
 * (Ship) or by composition: attach plain-data fields and let a World-level *system* act on
 * them, rather than growing the class hierarchy.
 *
 * It is abstract because "an entity of no kind" must not exist: every subclass declares a
 * literal `kind`, which is what makes `AnyEntity` (see kinds.ts) a discriminated union.
 */
export abstract class Entity {
  // Lab 2 gave every entity an id from a private static counter. Lab 5 moves that counter into
  // the World: a module-global counter lives once per JavaScript realm, so the browser and the
  // server (and a test that builds a second World) would number entities differently. The
  // world assigns ids in `spawn()`, in a deterministic order, and a snapshot refers to
  // entities by them.
  id: EntityId = entityId(0);

  abstract readonly kind: EntityKind;
  alive = true;

  pos: Vector2;
  vel: Vector2;
  angle: number;
  radius: number;
  /** Where it was one step ago — for render interpolation between steps (Lab 1). */
  prevPos: Vector2;
  prevAngle: number;
  /** Set by `attachHoming`; the World steers anything that has it. */
  homing?: Homing;

  constructor(
    pos: Vector2 = Vector2.zero,
    vel: Vector2 = Vector2.zero,
    { angle = 0, radius = 10 }: { angle?: number; radius?: number } = {},
  ) {
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
    this.prevPos = pos;
    this.prevAngle = angle;
  }

  /** Default physics: drift in a straight line. Subclasses/components override or add to this. */
  update(dt: number): void {
    this.pos = this.pos.add(this.vel.scale(dt));
  }
}
