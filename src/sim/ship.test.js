import test from "node:test";
import assert from "node:assert/strict";
import { Ship } from "./ship.js";
import { World } from "./world.js";
import { Vector2 } from "./vector.js";

const hold = { turn: 0, thrust: true, fire: false };

test("a fresh ship starts at full HP and alive", () => {
  const ship = new Ship(new Vector2(100, 100));
  assert.equal(ship.hp, ship.params.maxHp);
  assert.equal(ship.isDead, false);
});

test("#hp is truly private: nothing outside the class can write it directly", () => {
  const ship = new Ship(new Vector2(100, 100));
  // There is no setter for `hp` — only `get hp()` — so assigning to it throws in strict mode.
  assert.throws(() => {
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
  assert.equal(
    w.get(ship.id),
    ship,
    "a dead ship is NOT despawned — only bullets/asteroids/etc are swept",
  );
});

test("a dead ship respawns at a safe spot once the timer elapses", () => {
  const w = new World();
  const ship = w.spawn(new Ship(new Vector2(100, 100)));
  ship.takeDamage(1000, w);
  assert.equal(ship.isDead, true);
  for (let i = 0; i < 1000 && ship.isDead; i++) w.step(1 / 60, hold);
  assert.equal(ship.isDead, false, "respawn timer eventually elapses");
  assert.equal(ship.hp, ship.params.maxHp, "hp is restored on respawn");
});

test("fire() does nothing while the ship is dead", () => {
  const w = new World();
  const ship = w.spawn(new Ship(new Vector2(100, 100)));
  ship.takeDamage(1000, w);
  const bullet = ship.fire(w);
  assert.equal(bullet, null);
});

test("fire() respects its cooldown: rapid clicks don't spawn a bullet per click", () => {
  const w = new World();
  const ship = w.spawn(new Ship(new Vector2(100, 100)));
  const first = ship.fire(w);
  const second = ship.fire(w); // same instant — cooldown not elapsed yet
  assert.ok(first);
  assert.equal(second, null);
});

test("ship.fire called as a bare function throws — the `this` bug, reproduced", () => {
  const w = new World();
  const ship = w.spawn(new Ship(new Vector2(100, 100)));
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
