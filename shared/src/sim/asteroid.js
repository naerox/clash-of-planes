import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";
import { ARENA } from "./arena.js";

export const ASTEROID_PARAMS = Object.freeze({ minRadius: 20, maxRadius: 46, hp: 30, spin: 0.6 });
export const ASTEROID_CONTACT_DAMAGE = 25;

/** Drifts in a straight line and bounces off the arena edges — unlike the ship, which
 * wraps. Two different edge behaviors on purpose, so World.step has to ask each
 * entity's `kind`. */
export class Asteroid extends Entity {
  kind = "asteroid";

  /** @param spin radians/second. The caller picks it (from the world's seeded Rng): the
   * constructor itself must stay free of randomness. */
  constructor(pos, vel, radius = ASTEROID_PARAMS.maxRadius, params = ASTEROID_PARAMS, spin = 0) {
    super(pos, vel, { radius });
    this.hp = params.hp * (radius / params.maxRadius);
    this.spin = spin;
  }

  update(dt) {
    super.update(dt);
    this.angle += this.spin * dt;

    // Bounce: reflect the velocity component that would carry the asteroid out of bounds.
    if (this.pos.x - this.radius < 0 || this.pos.x + this.radius > ARENA.width) {
      this.vel = new Vector2(-this.vel.x, this.vel.y);
      this.pos = new Vector2(
        Math.min(Math.max(this.pos.x, this.radius), ARENA.width - this.radius),
        this.pos.y,
      );
    }
    if (this.pos.y - this.radius < 0 || this.pos.y + this.radius > ARENA.height) {
      this.vel = new Vector2(this.vel.x, -this.vel.y);
      this.pos = new Vector2(
        this.pos.x,
        Math.min(Math.max(this.pos.y, this.radius), ARENA.height - this.radius),
      );
    }
  }
}
