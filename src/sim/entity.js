import { Vector2 } from "./vector.js";

/**
 * Base class for everything that lives in the World: ships, bullets, asteroids,
 * pickups, explosion particles. Deliberately thin — position, velocity, a collision
 * radius, and an `update(dt)` that just moves it. Anything more specific (HP, TTL,
 * homing) is added either by a one-level subclass (Ship) or by composition (Section 3
 * of the lab): attach plain-data fields and let a World-level *system* act on them,
 * rather than growing the class hierarchy.
 */
export class Entity {
  // A private static field is shared by the class itself, not by instances — exactly
  // the "every bullet shares one counter" case the lab uses to motivate `static`.
  static #nextId = 1;

  // A private instance field: truly inaccessible from outside (not even `entity["#id"]`
  // reaches it), unlike the Lab 1 convention of just not touching a property.
  #id = Entity.#nextId++;

  kind = "entity";
  alive = true;

  constructor(pos = Vector2.zero, vel = Vector2.zero, { angle = 0, radius = 10 } = {}) {
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
  }

  get id() {
    return this.#id;
  }

  /** Default physics: drift in a straight line. Subclasses/components override or add to this. */
  update(dt) {
    this.pos = this.pos.add(this.vel.scale(dt));
  }
}
