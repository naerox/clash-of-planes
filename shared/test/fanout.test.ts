import { test } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";
import { SnapshotFanout, World, binaryCodec, buildSnapshot, seq, type Ship } from "../src/index.ts";

const DT = 1 / 30;

function busyWorld(seed: number, players: number): { world: World; ships: Ship[] } {
  const world = new World({
    seed,
    arena: { asteroids: 6, hunters: 1, asteroidSpeed: [40, 80] },
  }).populate();
  const ships = Array.from({ length: players }, (_, i) => world.addShip(`p${i}`));
  ships.forEach((s, i) => s.fire(world, seq(i + 1)));
  for (let i = 0; i < 5; i++) world.step(DT);
  return { world, ships };
}

test("a fanned-out frame is byte-for-byte what the codec encodes for that client", () => {
  const { world, ships } = busyWorld(11, 6);
  const events = world.drainEvents();
  const fanout = new SnapshotFanout(buildSnapshot(world, { events }));
  for (const ship of ships) {
    const expected = binaryCodec.encode(
      buildSnapshot(world, { shipId: ship.id, ack: seq(9), events }),
    );
    assert.deepEqual(fanout.frame(ship.toState(), seq(9)), expected);
  }
});

test("a spectator's frame (no ship) lists every ship", () => {
  const { world, ships } = busyWorld(3, 4);
  const fanout = new SnapshotFanout(buildSnapshot(world));
  const frame = binaryCodec.decode(fanout.frame(null, seq(0)));
  assert.ok(frame.type === "snapshot");
  assert.equal(frame.you, null);
  assert.equal(frame.ships.length, ships.length);
});

test("property: for any room size and seed, every client's fanned-out frame equals its own encode", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 9999 }), (n, seed) => {
      const { world, ships } = busyWorld(seed, n);
      const events = world.drainEvents();
      const fanout = new SnapshotFanout(buildSnapshot(world, { events }));
      return ships.every((ship) => {
        const expected = binaryCodec.encode(
          buildSnapshot(world, { shipId: ship.id, ack: seq(1), events }),
        );
        const got = fanout.frame(ship.toState(), seq(1));
        return got.length === expected.length && got.every((b, i) => b === expected[i]);
      });
    }),
    { numRuns: 40 },
  );
});
