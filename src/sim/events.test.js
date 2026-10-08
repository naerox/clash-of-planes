import test from "node:test";
import assert from "node:assert/strict";
import { World } from "./world.js";
import { Ship } from "./ship.js";
import { Asteroid } from "./asteroid.js";
import { Bullet } from "./bullet.js";
import { Vector2 } from "./vector.js";
import { EventBus, GAME_EVENTS } from "./events.js";

function record(bus) {
  const seen = [];
  for (const type of Object.values(GAME_EVENTS)) {
    bus.addEventListener(type, (e) => seen.push([type, e.detail]));
  }
  return seen;
}

test("ship.fire announces 'fired' on the bus", () => {
  const bus = new EventBus();
  const seen = record(bus);
  const world = new World({ events: bus });
  const ship = world.spawn(new Ship(new Vector2(100, 100)));
  ship.fire(world);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "fired");
  assert.equal(seen[0][1].shooterId, ship.id);
});

test("a bullet that destroys an asteroid emits 'hit' then 'exploded'", () => {
  const bus = new EventBus();
  const seen = record(bus);
  const world = new World({ events: bus });
  const owner = world.spawn(new Ship(new Vector2(800, 800)));
  const rock = world.spawn(new Asteroid(new Vector2(300, 300), Vector2.zero, 20));
  rock.hp = 1;
  world.spawn(new Bullet(new Vector2(300, 300), Vector2.zero, owner));
  world.step(1 / 60, { turn: 0, thrust: false, fire: false });
  assert.deepEqual(
    seen.map(([t]) => t),
    ["hit", "exploded"],
  );
  assert.equal(seen[1][1].kind, "asteroid");
});

test("the bus is synchronous: listeners have run by the time emit() returns", () => {
  const bus = new EventBus();
  let ran = false;
  bus.addEventListener("fired", () => (ran = true));
  bus.emit("fired", {});
  assert.equal(ran, true);
});
