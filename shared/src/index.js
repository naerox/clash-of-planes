// Everything the client and the server share. Pure JavaScript: no DOM, no Node built-ins,
// no clocks, no Math.random — enforced by test/purity.test.js and by the ESLint config.

export * from "./constants.js";
export * from "./input.js";
export * from "./protocol.js";
export * from "./snapshot.js";
export { hashWorld } from "./hash.js";
export { EXPECTED_HASH, runScenario, scenarioHash } from "./scenario.js";
export * from "./codec/index.js";

export { Rng } from "./sim/rng.js";
export { Vector2 } from "./sim/vector.js";
export { ARENA, wrap, wrappedDelta } from "./sim/arena.js";
export { TAU, clamp, lerp, wrapAngle, angleDelta } from "./sim/math.js";
export { Entity } from "./sim/entity.js";
export { Ship, SHIP_PARAMS, MUZZLE_SPEED } from "./sim/ship.js";
export { Bullet, BULLET_PARAMS } from "./sim/bullet.js";
export { Asteroid, ASTEROID_PARAMS, ASTEROID_CONTACT_DAMAGE } from "./sim/asteroid.js";
export { Pickup, PICKUP_KINDS, PICKUP_PARAMS } from "./sim/pickup.js";
export { attachHoming, applyHoming, HOMING_PARAMS } from "./sim/homing.js";
export { circlesOverlap, findCollisions } from "./sim/collision.js";
export { World, DEFAULT_ARENA } from "./sim/world.js";
