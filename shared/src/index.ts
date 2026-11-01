// Everything the client and the server share. Pure TypeScript: no DOM, no Node built-ins,
// no clocks, no Math.random — enforced by test/purity.test.ts and by the ESLint config.

export * from "./brand.ts";
export * from "./constants.ts";
export * from "./input.ts";
export * from "./protocol.ts";
export * from "./snapshot.ts";
export { hashWorld } from "./hash.ts";
export { EXPECTED_HASH, runScenario, scenarioHash } from "./scenario.ts";
export * from "./codec/index.ts";

export { Rng } from "./sim/rng.ts";
export { Vector2 } from "./sim/vector.ts";
export { ARENA, wrap, wrappedDelta } from "./sim/arena.ts";
export { TAU, clamp, lerp, wrapAngle, angleDelta } from "./sim/math.ts";
export { Entity, type EntityKind } from "./sim/entity.ts";
export { isKind, type AnyEntity, type EntityOfKind } from "./sim/kinds.ts";
export type { SimEvent, FiredEvent, HitEvent, ExplodedEvent, HitTarget } from "./sim/events.ts";
export { Ship, SHIP_PARAMS, MUZZLE_SPEED, type ShipState, type Shot } from "./sim/ship.ts";
export { Bullet, BULLET_PARAMS } from "./sim/bullet.ts";
export { Asteroid, ASTEROID_PARAMS, ASTEROID_CONTACT_DAMAGE } from "./sim/asteroid.ts";
export { Pickup, PICKUP_KINDS, PICKUP_PARAMS, type PickupType } from "./sim/pickup.ts";
export { attachHoming, applyHoming, HOMING_PARAMS, type Homing } from "./sim/homing.ts";
export {
  HASH_MIN_ENTITIES,
  circlesOverlap,
  findCollisions,
  findCollisionsHashed,
  findCollisionsNaive,
} from "./sim/collision.ts";
export {
  World,
  DEFAULT_ARENA,
  type ArenaConfig,
  type ShipInput,
  type WorldOptions,
} from "./sim/world.ts";
