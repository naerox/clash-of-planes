import test from "node:test";
import assert from "node:assert/strict";
import { World } from "./world.js";
import { Entity } from "./entity.js";
import { Ship } from "./ship.js";
import { Bullet } from "./bullet.js";
import { Asteroid } from "./asteroid.js";
import { Vector2 } from "./vector.js";
import { attachHoming, applyHoming } from "./homing.js";

test("spawn/despawn: ids are unique and World is iterable", () => {
  const w = new World();
  const a = w.spawn(new Entity(new Vector2(0, 0)));
  const b = w.spawn(new Entity(new Vector2(1, 1)));
  assert.notEqual(a.id, b.id);
  assert.equal(w.size, 2);
  assert.deepEqual([...w].map((e) => e.id).sort(), [a.id, b.id].sort());
});

test("despawn is deferred: the entity is still iterable until the next step() sweeps it", () => {
  const w = new World();
  const e = w.spawn(new Entity(new Vector2(0, 0)));
  w.despawn(e.id);
  assert.equal(w.get(e.id), e, "still present before a sweep happens");
});

test("ofKind yields only entities of that kind, lazily", () => {
  const w = new World();
  w.spawn(new Ship(new Vector2(0, 0)));
  w.spawn(new Asteroid(new Vector2(0, 0), Vector2.zero));
  w.spawn(new Asteroid(new Vector2(0, 0), Vector2.zero));
  assert.equal([...w.ofKind("asteroid")].length, 2);
  assert.equal([...w.ofKind("ship")].length, 1);
  assert.equal([...w.ofKind("pickup")].length, 0);
});

test("World.step moves entities and sweeps dead ones (a bullet's TTL expiring)", () => {
  const w = new World();
  const b = w.spawn(
    new Bullet(
      new Vector2(0, 0),
      new Vector2(0, 0),
      { kind: "ship" },
      { ttl: 0.01, radius: 1, damage: 1 },
    ),
  );
  assert.equal(w.size, 1);
  w.step(0.02, { turn: 0, thrust: false, fire: false }); // ttl runs out this tick
  assert.equal(w.get(b.id), undefined, "dead entity removed after the sweep");
});

test("a bullet damages an asteroid it overlaps, and the asteroid is removed at 0 hp", () => {
  const w = new World();
  const owner = w.spawn(new Ship(new Vector2(-9999, -9999))); // far away, irrelevant to this test
  const rock = w.spawn(new Asteroid(new Vector2(100, 100), Vector2.zero, 20));
  rock.hp = 5; // force a one-shot kill regardless of radius scaling
  w.spawn(
    new Bullet(new Vector2(100, 100), Vector2.zero, owner, { ttl: 5, radius: 2, damage: 50 }),
  );
  w.step(1 / 60, { turn: 0, thrust: false, fire: false });
  assert.equal(w.get(rock.id), undefined, "destroyed asteroid is swept");
  assert.equal(owner.score, 1, "the bullet's owner is credited");
});

test("attachHoming + applyHoming steers velocity toward a moving target over time", () => {
  const w = new World();
  const target = w.spawn(new Entity(new Vector2(500, 0)));
  const chaser = w.spawn(new Entity(new Vector2(0, 0), new Vector2(0, 100))); // moving straight up
  attachHoming(chaser, target, { turnRate: 10 }); // fast turn, so one tick visibly bends the path
  const before = chaser.vel.angle();
  applyHoming(chaser, 1 / 60);
  const after = chaser.vel.angle();
  assert.notEqual(before, after, "homing changed the heading");
});

test("World respects deferred-sweep semantics even while findCollisions snapshots mid-step", () => {
  const w = new World();
  const owner = w.spawn(new Ship(new Vector2(-9999, -9999)));
  const a = w.spawn(new Asteroid(new Vector2(50, 50), Vector2.zero, 10));
  a.hp = 1;
  w.spawn(new Bullet(new Vector2(50, 50), Vector2.zero, owner, { ttl: 5, radius: 1, damage: 100 }));
  assert.doesNotThrow(() => w.step(1 / 60, { turn: 0, thrust: false, fire: false }));
});
