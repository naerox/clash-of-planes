import type { Entity } from "./entity.ts";
import type { AnyEntity } from "./kinds.ts";
import { wrappedDelta } from "./arena.ts";
import { ARENA } from "./arena.ts";

/** Pure geometry: do two circles overlap? Nothing here knows about ships or bullets,
 * so this function can be swapped for a spatial hash (Lab 7) without touching World. */
export function circlesOverlap(a: Entity, b: Entity): boolean {
  const dx = wrappedDelta(a.pos.x, b.pos.x, ARENA.width);
  const dy = wrappedDelta(a.pos.y, b.pos.y, ARENA.height);
  const r = a.radius + b.radius;
  return dx * dx + dy * dy <= r * r;
}

/** Below this many live entities the plain double loop is faster than building a grid. */
export const HASH_MIN_ENTITIES = 48;

/**
 * A *system*, not a method on World: it takes a world (anything iterable over entities)
 * and yields colliding pairs.
 *
 * Lab 7: the naive version tests every pair (n²/2) and was the top JavaScript function of the
 * server's profile once a room held ~200 players. Now a SPATIAL HASH narrows the candidates: the
 * (wrapping) arena is cut into cells at least as wide as the largest possible touching distance
 * (2 × the biggest radius), so two circles can only touch if they sit in the same or in
 * neighbouring cells. The pairs come out in EXACTLY the order the naive loop produced them
 * (by the first entity's index, then the second's) — resolving them in a different order would
 * change who gets the kill, and the determinism hash — and a test compares both implementations.
 */
export function findCollisions(
  world: Iterable<AnyEntity>,
): Generator<readonly [AnyEntity, AnyEntity]> {
  const entities = [...world].filter((e) => e.alive);
  if (entities.length < HASH_MIN_ENTITIES) return findCollisionsNaive(entities);
  return findCollisionsHashed(entities);
}

/** The reference: every pair, tested in index order. */
export function* findCollisionsNaive(
  entities: readonly AnyEntity[],
): Generator<readonly [AnyEntity, AnyEntity]> {
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];
      if (!a || !b) continue; // noUncheckedIndexedAccess: the loop bounds make this unreachable
      if (!relevantPair(a, b)) continue;
      if (circlesOverlap(a, b)) yield [a, b] as const;
    }
  }
}

/** The same pairs in the same order, found through a grid. */
export function* findCollisionsHashed(
  entities: readonly AnyEntity[],
): Generator<readonly [AnyEntity, AnyEntity]> {
  let maxRadius = 0;
  for (const e of entities) if (e.radius > maxRadius) maxRadius = e.radius;
  const reach = Math.max(2 * maxRadius, 1);
  const cols = Math.floor(ARENA.width / reach);
  const rows = Math.floor(ARENA.height / reach);
  if (cols < 3 || rows < 3) {
    yield* findCollisionsNaive(entities); // a grid that small cannot tell neighbours from the same cell
    return;
  }

  // cells as linked lists of entity indices: no array per cell
  const head = new Int32Array(cols * rows).fill(-1);
  const next = new Int32Array(entities.length).fill(-1);
  const cellOf = new Int32Array(entities.length);
  const wrapCell = (v: number, size: number, n: number): number => {
    const c = Math.floor((v / size) * n);
    return ((c % n) + n) % n;
  };
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (!e) continue;
    const cell =
      wrapCell(e.pos.y, ARENA.height, rows) * cols + wrapCell(e.pos.x, ARENA.width, cols);
    cellOf[i] = cell;
    next[i] = head[cell] ?? -1;
    head[cell] = i;
  }

  const candidates: number[] = [];
  for (let i = 0; i < entities.length; i++) {
    const a = entities[i];
    if (!a) continue;
    const cell = cellOf[i] ?? 0;
    const cx = cell % cols;
    const cy = (cell - cx) / cols;
    candidates.length = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const row = ((cy + dy + rows) % rows) * cols;
      for (let dx = -1; dx <= 1; dx++) {
        for (let j = head[row + ((cx + dx + cols) % cols)] ?? -1; j >= 0; j = next[j] ?? -1) {
          if (j > i) candidates.push(j);
        }
      }
    }
    candidates.sort((p, q) => p - q);
    for (const j of candidates) {
      const b = entities[j];
      if (!b) continue;
      if (!relevantPair(a, b)) continue;
      if (circlesOverlap(a, b)) yield [a, b] as const;
    }
  }
}

/** Filters out pairs that can never meaningfully collide: same entity kind colliding with
 * itself (two bullets, two asteroids), and a bullet with its
 * own owner (otherwise every ship would instantly shoot itself). */
function relevantPair(a: AnyEntity, b: AnyEntity): boolean {
  if (a.kind === "bullet" && b.kind === "bullet") return false;
  if (a.kind === "asteroid" && b.kind === "asteroid") return false;
  if (a.kind === "bullet" && a.owner === b) return false;
  if (b.kind === "bullet" && b.owner === a) return false;
  return true;
}
