import { Vector2 } from "./vector.js";

/**
 * Base class for everything that lives in the World: ships, bullets, asteroids, pickups.
 * Deliberately thin — position, velocity, a collision radius, and an `update(dt)` that just
 * moves it. Anything more specific (HP, TTL, homing) is added either by a one-level subclass
 * (Ship) or by composition: attach plain-data fields and let a World-level *system* act on
 * them, rather than growing the class hierarchy.
 */
export class Entity {
  // Lab 2 gave every entity an id from a private static counter. Lab 5 moves that counter into
  // the World: a module-global counter lives once per JavaScript realm, so the browser and the
  // server (and a test that builds a second World) would number entities differently. The
  // world assigns ids in `spawn()`, in a deterministic order, and a snapshot refers to
  // entities by them.
  id = 0;

  kind = "entity";
  alive = true;

  constructor(pos = Vector2.zero, vel = Vector2.zero, { angle = 0, radius = 10 } = {}) {
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
  }

  /** Default physics: drift in a straight line. Subclasses/components override or add to this. */
  update(dt) {
    this.pos = this.pos.add(this.vel.scale(dt));
  }
}
