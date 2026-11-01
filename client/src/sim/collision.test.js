import test from "node:test";
import assert from "node:assert/strict";
import { circlesOverlap, findCollisions } from "./collision.js";
import { World } from "./world.js";
import { Bullet } from "./bullet.js";
import { Asteroid } from "./asteroid.js";
import { Ship } from "./ship.js";
import { Vector2 } from "./vector.js";

test("circlesOverlap: true when circles touch/overlap, false when apart", () => {
  const a = { pos: new Vector2(0, 0), radius: 10 };
  const b = { pos: new Vector2(15, 0), radius: 10 };
  const c = { pos: new Vector2(100, 0), radius: 10 };
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
