import { test } from "vitest";
import fc from "fast-check";
import assert from "node:assert/strict";
import {
  HASH_MIN_ENTITIES,
  circlesOverlap,
  findCollisions,
  findCollisionsHashed,
  findCollisionsNaive,
} from "../../src/sim/collision.ts";
import { World } from "../../src/sim/world.ts";
import { Bullet } from "../../src/sim/bullet.ts";
import { Asteroid } from "../../src/sim/asteroid.ts";
import { Pickup } from "../../src/sim/pickup.ts";
import { Ship } from "../../src/sim/ship.ts";
import { Vector2 } from "../../src/sim/vector.ts";

test("circlesOverlap: true when circles touch/overlap, false when apart", () => {
  const disk = (x: number, radius: number): Pickup => {
    const e = new Pickup(new Vector2(x, 0));
    e.radius = radius;
    return e;
  };
  const a = disk(0, 10);
  const b = disk(15, 10);
  const c = disk(100, 10);
  assert.ok(circlesOverlap(a, b));
  assert.ok(!circlesOverlap(a, c));
});

test("findCollisions skips a bullet colliding with its own owner", () => {
  const w = new World();
  const ship = w.spawn(new Ship(new Vector2(100, 100)));
  w.spawn(new Bullet(ship.pos, Vector2.zero, ship, { ttl: 5, radius: ship.radius, damage: 1 }));
  const pairs = [...findCollisions(w)];
  assert.equal(pairs.length, 0, "bullet must never collide with the ship that fired it");
});

test("findCollisions skips two asteroids overlapping each other", () => {
  const w = new World();
  w.spawn(new Asteroid(new Vector2(0, 0), Vector2.zero, 20));
  w.spawn(new Asteroid(new Vector2(5, 0), Vector2.zero, 20));
  assert.equal([...findCollisions(w)].length, 0);
});

test("findCollisions reports a bullet overlapping a non-owner asteroid", () => {
  const w = new World();
  const owner = w.spawn(new Ship(new Vector2(-500, -500)));
  w.spawn(new Asteroid(new Vector2(0, 0), Vector2.zero, 20));
  w.spawn(new Bullet(new Vector2(0, 0), Vector2.zero, owner, { ttl: 5, radius: 2, damage: 1 }));
  assert.equal([...findCollisions(w)].length, 1);
});

// ── Lab 7: the spatial hash must find exactly the pairs the naive loop finds, in the same order ──

import { ARENA } from "../../src/sim/arena.ts";
import { seq } from "../../src/index.ts";

function crowded(seed: number, ships: number, spread: number) {
  const w = new World({ seed, arena: { asteroids: 12, asteroidSpeed: [40, 80] } }).populate();
  const made = Array.from({ length: ships }, (_, i) => w.addShip(`s${i}`));
  made.forEach((s, i) => s.fire(w, seq(i + 1)));
  const rnd = (n: number) => {
    // a tiny deterministic generator, independent of the world's own
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * n;
  };
  // squeeze everything into a `spread`-sized patch (half of them across the wrap seam)
  for (const e of w) {
    const x = rnd(spread) - spread / 2;
    const y = rnd(spread) - spread / 2;
    e.pos = new Vector2((x + ARENA.width) % ARENA.width, (y + ARENA.height) % ARENA.height);
  }
  return [...w].filter((e) => e.alive);
}

test("spatial hash: same pairs, same order as the naive loop (random crowded worlds, wrap seam included)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100_000 }),
      fc.integer({ min: 0, max: 60 }),
      fc.integer({ min: 40, max: 1600 }),
      (seed, ships, spread) => {
        const entities = crowded(seed, ships, spread);
        const naive = [...findCollisionsNaive(entities)];
        const hashed = [...findCollisionsHashed(entities)];
        return (
          naive.length === hashed.length &&
          naive.every(([a, b], i) => hashed[i]?.[0] === a && hashed[i]?.[1] === b)
        );
      },
    ),
    { numRuns: 150 },
  );
});

test("spatial hash: the crowded fixtures really contain collisions (the comparison is not vacuous)", () => {
  const entities = crowded(5, 40, 120);
  assert.ok([...findCollisionsNaive(entities)].length > 5);
  assert.ok(entities.length >= HASH_MIN_ENTITIES);
});
