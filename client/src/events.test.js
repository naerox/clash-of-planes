import test from "node:test";
import assert from "node:assert/strict";
import { EventBus, GAME_EVENTS } from "./events.js";

test("the bus is synchronous: listeners have run by the time emit() returns", () => {
  const bus = new EventBus();
  let ran = false;
  bus.addEventListener(GAME_EVENTS.FIRED, () => (ran = true));
  bus.emit("fired", {});
  assert.equal(ran, true);
});

test("emit delivers the detail object, and each type has its own listeners", () => {
  const bus = new EventBus();
  const seen = [];
  bus.addEventListener("hit", (e) => seen.push(["hit", e.detail.damage]));
  bus.addEventListener("exploded", (e) => seen.push(["exploded", e.detail.kind]));
  bus.emit("hit", { damage: 12 });
  bus.emit("exploded", { kind: "ship" });
  bus.emit("fired", {}); // nobody listens: harmless
  assert.deepEqual(seen, [
    ["hit", 12],
    ["exploded", "ship"],
  ]);
});
