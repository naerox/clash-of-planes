import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";

export const PICKUP_PARAMS = Object.freeze({ radius: 14, respawnDelay: 6 });

export const PICKUP_KINDS = Object.freeze({
  SHIELD: "shield", // restores HP
  RAPID: "rapid", // halves fire cooldown for a while
});

/**
 * Stationary, collidable, but deliberately NOT a Ship and NOT an Entity subclass beyond
 * this one level — a pickup shares nothing behavioral with Ship (no thrust, no HP, no
 * firing), so forcing it under the same branch of a class tree would buy nothing. See
 * the README "Композиція замість успадкування" section for the full argument.
 */
export class Pickup extends Entity {
  kind = "pickup";

  constructor(pos, type = PICKUP_KINDS.SHIELD, params = PICKUP_PARAMS) {
    super(pos, Vector2.zero, { radius: params.radius });
    this.type = type;
  }
}
