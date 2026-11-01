import { Entity } from "./entity.js";

export const BULLET_PARAMS = Object.freeze({ ttl: 1.2, radius: 4, damage: 12 });

/** A bullet is almost pure data: position/velocity from Entity, plus a time-to-live. */
export class Bullet extends Entity {
  kind = "bullet";

  /**
   * @param owner the Ship that fired it — bullets never damage their own owner
   * @param seq   the `seq` of the input that fired it (0 if none). A client that predicts its
   *              own shots uses it to recognise the server's copy of the same bullet.
   */
  constructor(pos, vel, owner, params = BULLET_PARAMS, seq = 0) {
    super(pos, vel, { radius: params.radius });
    this.owner = owner;
    this.damage = params.damage;
    this.ttl = params.ttl;
    this.seq = seq;
  }

  update(dt) {
    super.update(dt); // Entity's straight-line drift
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
  }
}
