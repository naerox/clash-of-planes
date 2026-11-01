import { test } from "vitest";
import assert from "node:assert/strict";
import { World, Ship, Vector2, buildSnapshot, binaryCodec, seq } from "../src/index.ts";

const DT = 1 / 30;

test("a snapshot describes every kind of entity; the receiver's own ship is `you`, the others are `ships`", () => {
  const w = new World({
    seed: 8,
    arena: { asteroids: 5, hunters: 1, asteroidSpeed: [40, 80] },
  }).populate();
  const mine = w.addShip("me");
  const other = w.addShip("them");
  mine.fire(w, seq(12));
  w.step(DT);
  const events = w.drainEvents();
  const snap = buildSnapshot(w, { shipId: mine.id, ack: seq(12), events });

  assert.equal(snap.type, "snapshot");
  assert.equal(snap.tick, 1);
  assert.equal(snap.ack, 12);
  assert.equal(snap.you?.id, mine.id);
  assert.deepEqual(snap.you, mine.toState());
  assert.deepEqual(
    snap.ships.map((s) => s.id),
    [other.id],
  );
  assert.equal(snap.bullets.length, 1);
  assert.equal(snap.bullets[0]?.owner, mine.id);
  assert.equal(snap.bullets[0]?.seq, 12);
  assert.equal(snap.asteroids.length, 6);
  assert.equal(snap.asteroids.filter((a) => a.hunter).length, 1);
  assert.equal(snap.pickups.length, 1);
  assert.ok(events.some((e) => e.type === "fired"));
});

test("a spectator (no ship) gets `you: null` and sees all ships", () => {
  const w = new World({ seed: 1 });
  w.addShip("a");
  w.addShip("b");
  const snap = buildSnapshot(w, { shipId: null });
  assert.equal(snap.you, null);
  assert.equal(snap.ships.length, 2);
});

test("dead and rapid-fire flags are reported", () => {
  const w = new World({ seed: 1 });
  const a = w.addShip("a");
  const b = w.addShip("b");
  b.takeDamage(1000, w);
  a.applyPickup("rapid");
  const forB = buildSnapshot(w, { shipId: b.id });
  assert.equal(forB.ships[0]?.rapid, true);
  assert.ok(forB.you && forB.you.respawn > 0);
  assert.equal(buildSnapshot(w, { shipId: a.id }).ships[0]?.dead, true);
});

test("a real snapshot survives the binary codec: the client's replay starts from nearly the server's state", () => {
  const w = new World({ seed: 8 }).populate();
  const ship = w.addShip("me");
  for (let i = 0; i < 90; i++)
    w.applyInput(ship, { seq: seq(i + 1), thrust: true, turn: 1, fire: i % 6 === 0 }, DT);
  w.step(DT);
  const snap = buildSnapshot(w, { shipId: ship.id, ack: seq(90), events: w.drainEvents() });
  const back = binaryCodec.decode(binaryCodec.encode(snap));
  assert.ok(
    back.type === "snapshot" && back.you,
    "the snapshot decodes, with the receiver's own ship",
  );
  const clone = Ship.fromState(back.you);
  const err = new Vector2(clone.pos.x - ship.pos.x, clone.pos.y - ship.pos.y).length();
  assert.ok(err < 1e-3, `position error after f32 rounding: ${err}`);
  assert.equal(back.bullets.length, snap.bullets.length);
});
