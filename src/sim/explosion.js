import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";

export const EXPLOSION_PARTICLES = 10;

/** A single short-lived spark. An explosion is many of these, not one "explosion entity"
 * with custom draw logic — cheap, uniform, and exactly the kind of many-short-lived-object
 * pattern Lab 7's profiler will later point a finger at (object pooling fixes it there). */
export class Particle extends Entity {
  kind = "particle";

  constructor(pos) {
    const speed = 60 + Math.random() * 180;
    const angle = Math.random() * Math.PI * 2;
    super(pos, Vector2.fromAngle(angle, speed), { radius: 2 + Math.random() * 2 });
    this.ttl = 0.3 + Math.random() * 0.3;
    this.maxTtl = this.ttl;
  }

  update(dt) {
    super.update(dt);
    this.vel = this.vel.scale(Math.exp(-3 * dt));
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
  }
}

export function makeExplosionParticles(pos, count = EXPLOSION_PARTICLES) {
  return Array.from({ length: count }, () => new Particle(pos));
}
