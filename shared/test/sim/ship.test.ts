import { test } from "vitest";
import assert from "node:assert/strict";
import type { Controls } from "../../src/input.ts";
import { entityId, seq } from "../../src/brand.ts";
import { turnFrom } from "../helpers.ts";
import { Ship } from "../../src/sim/ship.ts";
import { World } from "../../src/sim/world.ts";
import { Vector2 } from "../../src/sim/vector.ts";

const DT = 1 / 30;
const coast: Controls = { turn: 0, thrust: false };
const hold: Controls = { turn: 0, thrust: true };

test("a fresh ship starts at full HP and alive", () => {
  const ship = new Ship(new Vector2(100, 100));
  assert.equal(ship.hp, ship.params.maxHp);
  assert.equal(ship.isDead, false);
});

test("#hp is truly private: nothing outside the class can write it directly", () => {
  const ship = new Ship(new Vector2(100, 100));
  assert.throws(() => {
    // @ts-expect-error `hp` is a getter without a setter: the compiler refuses it before the runtime does
    ship.hp = 9999;
  });
  assert.equal(ship.hp, ship.params.maxHp, "the private field is unaffected");
});

test("takeDamage reduces hp and triggers respawn-countdown (die) at 0", () => {
  const w = new World();
  const ship = w.spawn(new Ship(new Vector2(100, 100)));
  ship.takeDamage(30, w);
  assert.equal(ship.hp, 70);
  assert.equal(ship.isDead, false);
  ship.takeDamage(1000, w);
  assert.equal(ship.hp, 0);
  assert.equal(ship.isDead, true, "ship enters the respawn-timer state, not removed from World");
  assert.equal(w.get(ship.id), ship, "a dead ship is NOT despawned");
  assert.deepEqual(
    w.events.map((e) => e.type),
    ["exploded"],
    "dying is reported as an event",
  );
});

test("a dead ship respawns at a safe spot once the timer elapses (world clock, not inputs)", () => {
  const w = new World({ seed: 5 });
  const ship = w.spawn(new Ship(new Vector2(100, 100)));
  ship.takeDamage(1000, w);
  assert.equal(ship.isDead, true);
  for (let i = 0; i < 200 && ship.isDead; i++) w.step(DT);
  assert.equal(ship.isDead, false, "respawn timer eventually elapses");
  assert.equal(ship.hp, ship.params.maxHp, "hp is restored on respawn");
  assert.ok(Math.abs(w.tick * DT - ship.params.respawnDelay) < 2 * DT, "after ~2 s");
});

test("fire() does nothing while the ship is dead", () => {
  const w = new World();
  const ship = w.spawn(new Ship(new Vector2(100, 100)));
  ship.takeDamage(1000, w);
  assert.equal(ship.fire(w), null);
});

test("fire() respects its cooldown: rapid clicks don't spawn a bullet per click", () => {
  const w = new World();
  const ship = w.spawn(new Ship(new Vector2(100, 100)));
  const first = ship.fire(w);
  const second = ship.fire(w); // same instant — cooldown not elapsed yet
  assert.ok(first);
  assert.equal(second, null);
});

test("fire() announces itself as an event and tags the bullet with the input seq", () => {
  const w = new World();
  const ship = w.spawn(new Ship(new Vector2(100, 100)));
  const bullet = ship.fire(w, seq(77));
  assert.ok(bullet);
  assert.equal(bullet.seq, 77);
  assert.deepEqual(w.events[0], {
    type: "fired",
    shooterId: ship.id,
    x: bullet.pos.x,
    y: bullet.pos.y,
  });
});

test("ship.fire called as a bare function throws — the `this` bug, reproduced", () => {
  const w = new World();
  const ship = w.spawn(new Ship(new Vector2(100, 100)));
  // eslint-disable-next-line @typescript-eslint/unbound-method -- THE BUG being reproduced
  const bareFire = ship.fire; // just the function reference, like passing it to addEventListener
  assert.throws(
    () => bareFire(w),
    TypeError,
    "default binding leaves `this` undefined in strict mode",
  );
});

test("ship.fire bound explicitly (the fix) works correctly even called bare", () => {
  const w = new World();
  const ship = w.spawn(new Ship(new Vector2(100, 100)));
  const boundFire = ship.fire.bind(ship);
  assert.doesNotThrow(() => boundFire(w));
  assert.equal([...w.ofKind("bullet")].length, 1);
});

test("integrate: thrust accelerates along the heading, drag slows, speed is capped", () => {
  const ship = new Ship(new Vector2(800, 450));
  ship.angle = 0; // facing +x
  for (let i = 0; i < 10; i++) ship.integrate(hold, DT);
  assert.ok(ship.vel.x > 0 && Math.abs(ship.vel.y) < 1e-9);
  assert.ok(ship.thrusting);
  for (let i = 0; i < 300; i++) ship.integrate(hold, DT);
  assert.ok(ship.vel.length() <= ship.params.maxSpeed + 1e-9, "capped");
  const v = ship.vel.length();
  for (let i = 0; i < 30; i++) ship.integrate(coast, DT);
  assert.ok(ship.vel.length() < v, "drag");
});

test("integrate wraps around the arena edge and keeps prevPos for interpolation", () => {
  const ship = new Ship(new Vector2(1599, 450));
  ship.vel = new Vector2(400, 0);
  ship.integrate(coast, DT);
  assert.ok(ship.pos.x < 20, `wrapped, x = ${ship.pos.x}`);
  assert.equal(ship.prevPos.x, 1599);
});

test("integrate is a pure function of (state, controls, dt): two copies stay identical", () => {
  const a = new Ship(new Vector2(300, 300));
  const b = Ship.fromState({ ...a.toState(), id: entityId(9) });
  for (let i = 0; i < 500; i++) {
    const controls: Controls = { turn: turnFrom((i >> 3) % 3), thrust: i % 7 < 4 };
    a.integrate(controls, DT);
    b.integrate(controls, DT);
  }
  assert.deepEqual(a.toState(), { ...b.toState(), id: a.id });
});

test("a dead ship ignores controls (and stops thrusting)", () => {
  const w = new World();
  const ship = w.spawn(new Ship(new Vector2(100, 100)));
  ship.takeDamage(1000, w);
  const before = ship.pos;
  ship.integrate(hold, DT);
  assert.equal(ship.pos, before);
  assert.equal(ship.thrusting, false);
});

test("tryFire: cooldown halves under rapid fire; cooldown counts down in integrate", () => {
  const ship = new Ship(new Vector2(100, 100));
  assert.ok(ship.tryFire());
  assert.equal(ship.cooldown, ship.params.fireCooldown);
  ship.integrate(coast, DT);
  assert.ok(ship.cooldown < ship.params.fireCooldown);
  const rapid = new Ship(new Vector2(100, 100));
  rapid.applyPickup("rapid");
  rapid.tryFire();
  assert.equal(rapid.cooldown, rapid.params.fireCooldown / 2);
});

test("toState/setState round-trips everything a prediction needs, including private fields", () => {
  const w = new World();
  const a = w.spawn(new Ship(new Vector2(10, 20)));
  a.takeDamage(35, w);
  a.applyPickup("rapid");
  a.tryFire();
  a.integrate(hold, DT);
  a.score = 4;
  const state = a.toState();
  const b = Ship.fromState(state);
  assert.deepEqual(b.toState(), state);
  assert.equal(b.hp, 65);
  assert.ok(b.cooldown > 0 && b.rapidTimer > 0);
  assert.equal(b.id, a.id);
});
