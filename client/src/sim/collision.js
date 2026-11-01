import { wrappedDelta } from "./arena.js";
import { ARENA } from "./arena.js";

/** Pure geometry: do two circles overlap? Nothing here knows about ships or bullets,
 * so this function can be swapped for a spatial hash (Lab 7) without touching World. */
export function circlesOverlap(a, b) {
  const dx = wrappedDelta(a.pos.x, b.pos.x, ARENA.width);
  const dy = wrappedDelta(a.pos.y, b.pos.y, ARENA.height);
  const r = a.radius + b.radius;
  return dx * dx + dy * dy <= r * r;
}

/**
 * A *system*, not a method on World: it takes a world (anything iterable over entities)
 * and yields colliding pairs. Naive O(n²) — fine at this entity count (Lab 7 measures
 * exactly when it stops being fine, and swaps this for a spatial hash without the caller
 * changing at all).
 */
export function* findCollisions(world) {
  const entities = [...world].filter((e) => e.alive);
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];
      if (!relevantPair(a, b)) continue;
      if (circlesOverlap(a, b)) yield [a, b];
    }
  }
}

/** Filters out pairs that can never meaningfully collide: same entity kind colliding with
 * itself (two bullets, two asteroids), particles (purely visual), and a bullet with its
 * own owner (otherwise every ship would instantly shoot itself). */
function relevantPair(a, b) {
  if (a.kind === "particle" || b.kind === "particle") return false;
  if (a.kind === "bullet" && b.kind === "bullet") return false;
  if (a.kind === "asteroid" && b.kind === "asteroid") return false;
  if (a.kind === "bullet" && a.owner === b) return false;
  if (b.kind === "bullet" && b.owner === a) return false;
  return true;
}
