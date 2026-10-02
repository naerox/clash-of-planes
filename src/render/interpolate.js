import { ARENA, wrap, wrappedDelta } from "../sim/arena.js";
import { angleDelta, lerp } from "../sim/math.js";
import { Vector2 } from "../sim/vector.js";

/** Lerp along the *shortest* path on a wrapping axis, so crossing an edge doesn't sweep the arena. */
export function lerpWrapped(a, b, t, size) {
  return wrap(a + wrappedDelta(a, b, size) * t, size);
}

export function lerpAngle(a, b, t) {
  return a + angleDelta(a, b) * t;
}

/** Plain (non-wrapping) vector lerp, for everything that doesn't wrap around the arena
 * edge — bullets, asteroids, particles, pickups. Only the ship uses `lerpWrapped`. */
export function lerpVec(a, b, t) {
  return new Vector2(lerp(a.x, b.x, t), lerp(a.y, b.y, t));
}

/** Interpolated draw-position for ANY entity: `prevPos`/`prevAngle` were captured by
 * World.step right before `update()` ran (see world.js), so every entity — not just the
 * ship — gets smooth interpolation for free, with the ship as the one special case that
 * also needs to lerp the "short way" across a wrapped edge. */
export function interpolatedPose(entity, alpha) {
  const prevPos = entity.prevPos ?? entity.pos;
  const prevAngle = entity.prevAngle ?? entity.angle;
  const pos =
    entity.kind === "ship"
      ? new Vector2(
          lerpWrapped(prevPos.x, entity.pos.x, alpha, ARENA.width),
          lerpWrapped(prevPos.y, entity.pos.y, alpha, ARENA.height),
        )
      : lerpVec(prevPos, entity.pos, alpha);
  return { pos, angle: lerpAngle(prevAngle, entity.angle, alpha) };
}
