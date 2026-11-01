import { Vector2 } from "./vector.js";
import { wrapAngle, angleDelta } from "./math.js";

export const HOMING_PARAMS = Object.freeze({ turnRate: 2.4 });

/**
 * Composition, not inheritance (Lab 2, "behavior as data"). A homing bullet and a homing
 * asteroid share nothing else, so `attachHoming` just adds a plain `homing` field to whatever
 * entity is passed in, and a single system function, `applyHoming`, steers anything that has it.
 *
 * Lab 5: with several players there is no single ship to hunt. `target` may be `null`, and
 * `applyHoming` then picks the NEAREST living ship in the world (ties go to the first in
 * insertion order, so the choice is deterministic).
 */
export function attachHoming(entity, target = null, params = HOMING_PARAMS) {
  entity.homing = { target, turnRate: params.turnRate };
  return entity;
}

function nearestShip(world, from) {
  let best = null;
  let bestDist = Infinity;
  for (const ship of world.ofKind("ship")) {
    if (ship.isDead) continue;
    const d = ship.pos.sub(from).length();
    if (d < bestDist) {
      best = ship;
      bestDist = d;
    }
  }
  return best;
}

/** The system: steers `entity.vel` toward its target, if it has a live one. */
export function applyHoming(entity, dt, world = null) {
  const h = entity.homing;
  if (!h) return;
  if (world && (!h.target || !h.target.alive || h.target.isDead)) {
    h.target = nearestShip(world, entity.pos);
  }
  if (!h.target || !h.target.alive) return;

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
