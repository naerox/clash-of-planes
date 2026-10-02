import { Entity } from "./entity.js";

export const BULLET_PARAMS = Object.freeze({ ttl: 1.2, radius: 4, damage: 12 });

/** A bullet is almost pure data: position/velocity from Entity, plus a time-to-live. */
export class Bullet extends Entity {
  kind = "bullet";

  constructor(pos, vel, owner, params = BULLET_PARAMS) {
    super(pos, vel, { radius: params.radius });
    this.owner = owner; // the Ship that fired it — bullets never damage their own owner
    this.damage = params.damage;
    this.ttl = params.ttl;
  }

  update(dt) {
    super.update(dt); // Entity's straight-line drift
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
  }
}
