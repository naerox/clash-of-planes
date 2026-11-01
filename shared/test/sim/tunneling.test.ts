// "Fast bullet tunneling — does yours?" Yes, for grazing shots. Collisions are tested once per
// 1/30 s step, between where things ARE; a bullet at 900 u/s moves 30 units per step, so it can
// jump clean over a target whose chord through the bullet's path is shorter than that.

import { describe, expect, test } from "vitest";
import { Asteroid, Bullet, MUZZLE_SPEED, STEP, Ship, Vector2, World } from "../../src/index.ts";

/** Fires a bullet at `speed` along +x past an asteroid at distance `offset` from its centre; true if it hit. */
function shotHits(speed: number, offset: number, phase: number): boolean {
  const world = new World({ seed: 1 });
  const owner = new Ship(new Vector2(-5000, -5000)); // somewhere else: not in the world
  const rock = world.spawn(new Asteroid(new Vector2(800, 450), Vector2.zero, 20));
  const bullet = world.spawn(
    new Bullet(new Vector2(600 + phase, 450 + offset), new Vector2(speed, 0), owner, {
      ttl: 5,
      radius: 4,
      damage: 12,
    }),
  );
  for (let i = 0; i < 40 && bullet.alive; i++) world.step(STEP);
  return rock.hp < 30 * (20 / 46) || !bullet.alive;
}

describe("a bullet at full speed", () => {
  const SPEED = MUZZLE_SPEED + 420; // muzzle speed plus a ship flying at top speed: the worst case
  const perStep = SPEED * STEP;

  test("moves further per step than a small target is wide (the precondition for tunneling)", () => {
    expect(perStep).toBeGreaterThan(2 * (20 + 4) * 0.6);
  });

  test("never misses a target it flies straight through the middle of", () => {
    for (let phase = 0; phase < perStep; phase += 1) expect(shotHits(SPEED, 0, phase)).toBe(true);
  });

  test("DOES tunnel through a grazing shot for some phases — the known limitation", () => {
    let misses = 0;
    let hits = 0;
    // offset 23 of a combined radius 24: the chord is 2·√(24²−23²) ≈ 13.8 units, under half a step
    for (let phase = 0; phase < perStep; phase += 1) {
      if (shotHits(SPEED, 23, phase)) hits++;
      else misses++;
    }
    expect(misses).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);
    // roughly: the share that hits is chord / step
    expect(hits / (hits + misses)).toBeCloseTo(13.8 / perStep, 1);
  });

  test("slow bullets do not tunnel: the same grazing shot at 300 u/s always lands", () => {
    for (let phase = 0; phase < 300 * STEP; phase += 0.5)
      expect(shotHits(300, 23, phase)).toBe(true);
  });
});
