import { NO_SEQ, type Seq } from "../brand.ts";
import { Entity } from "./entity.ts";
import type { Ship } from "./ship.ts";
import type { Vector2 } from "./vector.ts";

export interface BulletParams {
  readonly ttl: number;
  readonly radius: number;
  readonly damage: number;
}
export const BULLET_PARAMS: BulletParams = Object.freeze({ ttl: 1.2, radius: 4, damage: 12 });

/** A bullet is almost pure data: position/velocity from Entity, plus a time-to-live. */
export class Bullet extends Entity {
  readonly kind = "bullet";
  readonly owner: Ship;
  readonly damage: number;
  ttl: number;
  readonly seq: Seq;

  /**
   * @param owner the Ship that fired it — bullets never damage their own owner
   * @param seq   the `seq` of the input that fired it (0 if none). A client that predicts its
   *              own shots uses it to recognise the server's copy of the same bullet.
   */
  constructor(
    pos: Vector2,
    vel: Vector2,
    owner: Ship,
    params: BulletParams = BULLET_PARAMS,
    seq: Seq = NO_SEQ,
  ) {
    super(pos, vel, { radius: params.radius });
    this.owner = owner;
    this.damage = params.damage;
    this.ttl = params.ttl;
    this.seq = seq;
  }

  override update(dt: number): void {
    super.update(dt); // Entity's straight-line drift
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
  }
}
