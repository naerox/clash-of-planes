import { Entity } from "./entity.ts";
import { Vector2 } from "./vector.ts";

export interface PickupParams {
  readonly radius: number;
  readonly respawnDelay: number;
}
export const PICKUP_PARAMS: PickupParams = Object.freeze({ radius: 14, respawnDelay: 6 });

export const PICKUP_KINDS = Object.freeze({
  SHIELD: "shield", // restores HP
  RAPID: "rapid", // halves fire cooldown for a while
});
export type PickupType = (typeof PICKUP_KINDS)[keyof typeof PICKUP_KINDS];

/**
 * Stationary, collidable, but deliberately NOT a Ship and NOT an Entity subclass beyond
 * this one level — a pickup shares nothing behavioral with Ship (no thrust, no HP, no
 * firing), so forcing it under the same branch of a class tree would buy nothing. See
 * the README "Композиція замість успадкування" section for the full argument.
 */
export class Pickup extends Entity {
  readonly kind = "pickup";
  readonly type: PickupType;

  constructor(
    pos: Vector2,
    type: PickupType = PICKUP_KINDS.SHIELD,
    params: PickupParams = PICKUP_PARAMS,
  ) {
    super(pos, Vector2.zero, { radius: params.radius });
    this.type = type;
  }
}
