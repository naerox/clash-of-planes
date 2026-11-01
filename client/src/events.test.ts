import test from "node:test";
import assert from "node:assert/strict";
import { entityId } from "@dogfight/shared";
import { Bus, emitSimEvent, type GameEvents } from "./events.ts";

const hit = (damage: number): GameEvents["hit"] => ({
  type: "hit",
  target: "ship",
  targetId: entityId(1),
  x: 0,
  y: 0,
  damage,
});

test("the bus is synchronous: listeners have run by the time emit() returns", () => {
  const bus = new Bus<GameEvents>();
  let ran = false;
  bus.on("fired", () => (ran = true));
  bus.emit("fired", { type: "fired", shooterId: entityId(1), x: 0, y: 0 });
  assert.equal(ran, true);
});

test("emit delivers the payload, typed per event, and each type has its own listeners", () => {
  const bus = new Bus<GameEvents>();
  const seen: [string, number | string][] = [];
  bus.on("hit", (e) => seen.push(["hit", e.damage]));
  bus.on("exploded", (e) => seen.push(["exploded", e.kind]));
  bus.emit("hit", hit(12));
  bus.emit("exploded", { type: "exploded", kind: "ship", id: entityId(2), x: 0, y: 0, radius: 9 });
  bus.emit("fired", { type: "fired", shooterId: entityId(1), x: 0, y: 0 }); // nobody listens
  assert.deepEqual(seen, [
    ["hit", 12],
    ["exploded", "ship"],
  ]);
});

test("a throwing listener does not stop the others; its error goes to the bus's error handler", () => {
  const errors: unknown[] = [];
  const bus = new Bus<GameEvents>((err) => errors.push(err));
  const seen: number[] = [];
  bus.on("hit", () => {
    throw new Error("boom");
  });
  bus.on("hit", (e) => seen.push(e.damage));
  bus.emit("hit", hit(3));
  assert.deepEqual(seen, [3]);
  assert.equal(errors.length, 1);
});

test("once and signal remove listeners", () => {
  const bus = new Bus<GameEvents>();
  let once = 0;
  let aborted = 0;
  const ac = new AbortController();
  bus.on("hit", () => once++, { once: true });
  bus.on("hit", () => aborted++, { signal: ac.signal });
  bus.emit("hit", hit(1));
  ac.abort();
  bus.emit("hit", hit(1));
  assert.deepEqual([once, aborted], [1, 1]);
});

test("emitSimEvent routes a SimEvent to the listeners of its own type", () => {
  const bus = new Bus<GameEvents>();
  const seen: string[] = [];
  bus.on("fired", () => seen.push("fired"));
  bus.on("hit", () => seen.push("hit"));
  emitSimEvent(bus, hit(1));
  emitSimEvent(bus, { type: "fired", shooterId: entityId(1), x: 0, y: 0 });
  assert.deepEqual(seen, ["hit", "fired"]);
});
