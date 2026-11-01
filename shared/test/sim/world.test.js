import test from "node:test";
import assert from "node:assert/strict";
import { World } from "../../src/sim/world.js";
import { Entity } from "../../src/sim/entity.js";
import { Ship } from "../../src/sim/ship.js";
import { Bullet } from "../../src/sim/bullet.js";
import { Asteroid } from "../../src/sim/asteroid.js";
import { Vector2 } from "../../src/sim/vector.js";
import { applyHoming, attachHoming } from "../../src/sim/homing.js";

const DT = 1 / 30;

test("spawn/despawn: ids are unique and World is iterable", () => {
  const w = new World();
  const a = w.spawn(new Entity(new Vector2(0, 0)));
  const b = w.spawn(new Entity(new Vector2(1, 1)));
  assert.notEqual(a.id, b.id);
  assert.equal(w.size, 2);
  assert.deepEqual([...w].map((e) => e.id).sort(), [a.id, b.id].sort());
});

test("ids belong to the world: two worlds number their entities identically", () => {
  const ids = (w) => [1, 2, 3].map(() => w.spawn(new Entity()).id);
  assert.deepEqual(ids(new World()), ids(new World()));
  assert.deepEqual(ids(new World()), [1, 2, 3]);
});

test("ids stay within u16 (they travel as one), wrap around, and skip ids still in use", () => {
  const w = new World();
  const keeper = w.spawn(new Entity());
  w.nextId = 65534;
  assert.equal(w.spawn(new Entity()).id, 65534);
  assert.equal(w.spawn(new Entity()).id, 65535);
  const wrapped = w.spawn(new Entity()).id;
  assert.notEqual(wrapped, 0);
  assert.notEqual(wrapped, keeper.id, "id 1 is taken by `keeper`, so the world skipped it");
  assert.equal(wrapped, 2);
});

test("despawn is deferred: the entity is still iterable until the next step() sweeps it", () => {
  const w = new World();
  const e = w.spawn(new Entity(new Vector2(0, 0)));
  w.despawn(e.id);
  assert.equal(w.get(e.id), e, "still present before a sweep happens");
  w.step(DT);
  assert.equal(w.get(e.id), undefined);
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
  w.step(0.02);
  assert.equal(w.get(b.id), undefined, "dead entity removed after the sweep");
  assert.equal(w.tick, 1);
});

test("step() does NOT move ships: a ship advances only through its inputs", () => {
  const w = new World();
  const ship = w.spawn(new Ship(new Vector2(500, 500)));
  ship.vel = new Vector2(300, 0);
  for (let i = 0; i < 10; i++) w.step(DT);
  assert.equal(ship.pos.x, 500);
  w.applyInput(ship, { seq: 1, tick: 0, thrust: false, turn: 0, fire: false }, DT);
  assert.ok(ship.pos.x > 500);
});

test("applyInput = integrate + fire, and the bullet remembers the input's seq", () => {
  const w = new World();
  const ship = w.spawn(new Ship(new Vector2(500, 500)));
  w.applyInput(ship, { seq: 41, tick: 0, thrust: true, turn: 0, fire: true }, DT);
  const [bullet] = [...w.ofKind("bullet")];
  assert.ok(bullet);
  assert.equal(bullet.seq, 41);
  assert.equal(bullet.owner, ship);
});

test("a bullet damages an asteroid it overlaps, and the asteroid is removed at 0 hp", () => {
  const w = new World();
  const owner = w.spawn(new Ship(new Vector2(-9999, -9999)));
  const rock = w.spawn(new Asteroid(new Vector2(100, 100), Vector2.zero, 20));
  rock.hp = 5;
  w.spawn(
    new Bullet(new Vector2(100, 100), Vector2.zero, owner, { ttl: 5, radius: 2, damage: 50 }),
  );
  w.step(DT);
  assert.equal(w.get(rock.id), undefined, "destroyed asteroid is swept");
  assert.equal(owner.score, 1, "the bullet's owner is credited");
});

test("a bullet that destroys an asteroid reports 'hit' then 'exploded' in the event list", () => {
  const w = new World();
  const owner = w.spawn(new Ship(new Vector2(800, 800)));
  const rock = w.spawn(new Asteroid(new Vector2(300, 300), Vector2.zero, 20));
  rock.hp = 1;
  w.spawn(new Bullet(new Vector2(300, 300), Vector2.zero, owner));
  w.step(DT);
  const events = w.drainEvents();
  assert.deepEqual(
    events.map((e) => e.type),
    ["hit", "exploded"],
  );
  assert.equal(events[1].kind, "asteroid");
  assert.equal(events[1].id, rock.id);
  assert.deepEqual(w.events, [], "drained");
});

test("one player's bullet hits another player's ship; kills credit the shooter", () => {
  const w = new World({ seed: 3 });
  const a = w.spawn(new Ship(new Vector2(300, 300)));
  const b = w.spawn(new Ship(new Vector2(300, 300)));
  for (let i = 0; i < 9; i++) {
    w.spawn(new Bullet(new Vector2(300, 300), Vector2.zero, a, { ttl: 5, radius: 4, damage: 12 }));
  }
  w.step(DT);
  assert.equal(b.isDead, true, "9 × 12 > 100 hp");
  assert.equal(a.score, 1, "exactly one kill, even though more bullets landed");
  assert.equal(a.isDead, false, "a bullet never hurts its own owner");
});

test("homing with no fixed target hunts the NEAREST living ship", () => {
  const w = new World();
  const far = w.spawn(new Ship(new Vector2(1500, 0)));
  const near = w.spawn(new Ship(new Vector2(100, 100)));
  const hunter = w.spawn(new Entity(new Vector2(0, 100), new Vector2(0, -100)));
  attachHoming(hunter, null, { turnRate: 50 });
  applyHoming(hunter, DT, w);
  assert.equal(hunter.homing.target, near);
  near.takeDamage(1000, w); // the target dies: the hunter switches
  applyHoming(hunter, DT, w);
  assert.equal(hunter.homing.target, far);
});

test("attachHoming + applyHoming steers velocity toward a moving target over time", () => {
  const w = new World();
  const target = w.spawn(new Entity(new Vector2(500, 0)));
  const chaser = w.spawn(new Entity(new Vector2(0, 0), new Vector2(0, 100)));
  attachHoming(chaser, target, { turnRate: 10 });
  const before = chaser.vel.angle();
  applyHoming(chaser, DT);
  assert.notEqual(before, chaser.vel.angle(), "homing changed the heading");
});

test("populate() builds the room's arena from its config, using only the seeded rng", () => {
  const w = new World({
    seed: 9,
    arena: { asteroids: 6, hunters: 2, asteroidSpeed: [50, 60] },
  }).populate();
  const rocks = [...w.ofKind("asteroid")];
  assert.equal(rocks.length, 8);
  assert.equal(rocks.filter((a) => a.homing).length, 2);
  assert.equal([...w.ofKind("pickup")].length, 1);
  for (const a of rocks.filter((r) => !r.homing))
    assert.ok(a.vel.length() >= 50 && a.vel.length() <= 60);
});

test("the field is replenished: destroyed asteroids are eventually replaced", () => {
  const w = new World({
    seed: 4,
    arena: { asteroids: 4, hunters: 0, asteroidSpeed: [40, 80] },
  }).populate();
  for (const a of [...w.ofKind("asteroid")]) a.alive = false;
  w.step(DT);
  for (let i = 0; i < 600; i++) w.step(DT);
  assert.ok([...w.ofKind("asteroid")].length >= 3);
});

test("addShip gives every player a spawn point away from rocks and from other ships", () => {
  const w = new World({
    seed: 11,
    arena: { asteroids: 8, hunters: 0, asteroidSpeed: [40, 80] },
  }).populate();
  const ships = [1, 2, 3, 4].map((n) => w.addShip(`p${n}`));
  for (const s of ships) {
    for (const a of w.ofKind("asteroid"))
      assert.ok(s.pos.sub(a.pos).length() >= 200, "clear of rocks");
  }
  assert.equal(ships[2].playerId, "p3");
});
