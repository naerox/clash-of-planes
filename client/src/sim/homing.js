import { Vector2 } from "./vector.js";
import { wrapAngle, angleDelta } from "./math.js";

export const HOMING_PARAMS = Object.freeze({ turnRate: 2.4 });

/**
 * Composition, not inheritance (lab Section 3, "behavior as data"). A homing bullet and
 * a homing asteroid share nothing else — a bullet has `ttl` and `damage`, an asteroid has
 * `hp` and bounces off walls. Giving both `Entity → Moving → Homing → …` would force a
 * shared ancestor neither wants. Instead, `attachHoming` just adds a plain `homing` field
 * to whatever entity is passed in (bullet OR asteroid, duck-typed), and a single system
 * function, `applyHoming`, checks for that field and steers anything that has it.
 *
 *   attachHoming(bullet, target);      // a homing bullet
 *   attachHoming(asteroid, playerShip); // an asteroid that hunts the player
 *
 * World.step calls `applyHoming` once per entity per tick; entities without `.homing`
 * are skipped in O(1), so this costs nothing for the (common) non-homing case.
 */
export function attachHoming(entity, target, params = HOMING_PARAMS) {
  entity.homing = { target, turnRate: params.turnRate };
  return entity;
}

/** The system: steers `entity.vel` toward `entity.homing.target`, if both are still alive. */
export function applyHoming(entity, dt) {
  const h = entity.homing;
  if (!h || !h.target.alive) return;

  const toTarget = h.target.pos.sub(entity.pos);
  if (toTarget.length() < 1) return;

  const wantedAngle = toTarget.angle();
  const currentAngle = entity.vel.length() > 0 ? entity.vel.angle() : wantedAngle;
  const turn = Math.max(
    -h.turnRate * dt,
    Math.min(h.turnRate * dt, angleDelta(currentAngle, wantedAngle)),
  );
  const newAngle = wrapAngle(currentAngle + turn);
  const speed = entity.vel.length() || 200;
  entity.vel = Vector2.fromAngle(newAngle, speed);
}
