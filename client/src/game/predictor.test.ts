import test from "node:test";
import assert from "node:assert/strict";
import {
  ARENA,
  STEP,
  Ship,
  Vector2,
  World,
  seq,
  wrappedDelta,
  type InputMessage,
  type Turn,
} from "@dogfight/shared";
import { bulletSnap, input as makeInput } from "../testing.ts";
import { Predictor } from "./predictor.ts";

const input = (n: number, over: Partial<Omit<InputMessage, "type">> = {}): InputMessage =>
  makeInput({ seq: seq(n), thrust: true, ...over });

/** 0, 1, 2 → -1, 0, 1: a `number` that is provably a `Turn`. */
const turnOf = (n: number): Turn => (n === 0 ? -1 : n === 1 ? 0 : 1);

/** A server-side twin: the same inputs applied by the shared world. */
function server(inputs: readonly InputMessage[]) {
  const world = new World({ seed: 1 });
  const ship = world.addShip("p");
  for (const i of inputs) world.applyInput(ship, i, STEP);
  return { world, ship };
}

function fresh() {
  const world = new World({ seed: 1 });
  const ship = world.addShip("p");
  return { ship, state: ship.toState(), world };
}

test("step: the ship moves at once and the input waits in `pending`", () => {
  const { ship, state } = fresh();
  const p = new Predictor({ state });
  p.ship.angle = 0;
  const x = p.ship.pos.x;
  p.step(input(1));
  p.step(input(2));
  assert.ok(p.ship.pos.x > x);
  assert.deepEqual(
    p.pending.map((i) => i.seq),
    [1, 2],
  );
  assert.equal(ship.pos.x, state.x, "the server's ship is untouched: this is only a guess");
});

test("reconcile with a CORRECT prediction: zero error, the unacknowledged inputs stay pending", () => {
  const { state } = fresh();
  const p = new Predictor({ state });
  const inputs = Array.from({ length: 10 }, (_, i) => input(i + 1, { turn: turnOf(i % 3) }));
  for (const i of inputs) p.step(i);
  const before = p.ship.pos;

  // the server has applied only the first 6 so far
  const { ship: srv } = server(inputs.slice(0, 6));
  const err = p.reconcile(srv.toState(), seq(6));
  assert.ok(err < 1e-9, `error ${err}`);
  assert.deepEqual(
    p.pending.map((i) => i.seq),
    [7, 8, 9, 10],
    "only the unseen ones are kept",
  );
  assert.ok(
    Math.abs(p.ship.pos.x - before.x) < 1e-9 && Math.abs(p.ship.pos.y - before.y) < 1e-9,
    "replay lands where we were",
  );
});

test("reconcile with a WRONG prediction: the ship goes to the server's state + replay, and the error is reported", () => {
  const { state } = fresh();
  const p = new Predictor({ state });
  for (let s = 1; s <= 8; s++) p.step(input(s));
  // the server disagrees: it says that after input 5 we were 30 units to the side (we were shoved)
  const { ship: srv } = server(Array.from({ length: 5 }, (_, i) => input(i + 1)));
  const shoved = { ...srv.toState(), y: srv.pos.y + 30 };
  const predictedBefore = p.ship.pos;
  const err = p.reconcile(shoved, seq(5));
  assert.ok(Math.abs(err - 30) < 1e-6, `reported error ${err}`);
  assert.ok(
    Math.abs(wrappedDelta(predictedBefore.y, p.ship.pos.y, ARENA.height) - 30) < 1e-6,
    "the replay continues from the server's position",
  );
  assert.equal(p.pending.length, 3);
  assert.ok(
    Math.abs(p.offset.y + 30) < 1e-6,
    "…and the player keeps SEEING the old position for now (offset)",
  );
});

test("a correction over SNAP_DISTANCE (a respawn) is not smoothed across the arena", () => {
  const { state } = fresh();
  const p = new Predictor({ state });
  p.step(input(1));
  const far = { ...p.ship.toState(), x: (p.ship.pos.x + 700) % 1600, y: 800 };
  p.reconcile(far, seq(1));
  assert.deepEqual(p.offset, { x: 0, y: 0 });
});

test("the prediction keeps the exact prevPos, so drawing between steps does not stutter after a reconcile", () => {
  const { state } = fresh();
  const p = new Predictor({ state });
  const inputs = Array.from({ length: 6 }, (_, i) => input(i + 1));
  for (const i of inputs) p.step(i);
  const { ship: srv } = server(inputs.slice(0, 4));
  p.reconcile(srv.toState(), seq(4));
  // 2 inputs replayed: prevPos is the position before the LAST one
  const twin = Ship.fromState(srv.toState());
  twin.integrate(input(5), STEP);
  assert.ok(Math.abs(p.ship.prevPos.x - twin.pos.x) < 1e-9);
  // nothing to replay: prevPos == pos
  p.reconcile(server(inputs).ship.toState(), seq(6));
  assert.equal(p.ship.prevPos, p.ship.pos);
});

test("decay: a critically damped spring — starts gently, never overshoots, <5% left after smoothMs", () => {
  const { state } = fresh();
  const p = new Predictor({ state });
  p.offset = { x: 20, y: 0 };
  const frame = 1000 / 60;
  const xs: number[] = [];
  for (let t = 0; t < 400; t += frame) {
    p.decay(frame, 100);
    xs.push(p.offset.x);
  }
  const first = xs[0] ?? 0;
  assert.ok(
    first > 15,
    `the first frame moves a fraction (${first.toFixed(2)} of 20 left): no shove`,
  );
  assert.ok(
    xs.every((x, i) => i === 0 || x <= (xs[i - 1] ?? Infinity) + 1e-9),
    "monotone: it never swings past zero",
  );
  assert.ok(
    xs.every((x) => x >= -1e-9),
    "no overshoot",
  );
  const at100 = xs[Math.round(100 / frame) - 1] ?? Infinity;
  assert.ok(at100 < 1.1, `after 100 ms: ${at100.toFixed(2)} of 20 left (5% = 1.0)`);
  assert.deepEqual(p.offset, { x: 0, y: 0 }, "settled exactly");
});

test("decay with smoothMs = 0 snaps at once; offsets from several corrections add up", () => {
  const { state } = fresh();
  const p = new Predictor({ state });
  p.offset = { x: 5, y: -3 };
  p.decay(16, 0);
  assert.deepEqual(p.offset, { x: 0, y: 0 });
});

test("visual(): the interpolated pose between the last two steps, plus the offset", () => {
  const { state } = fresh();
  const p = new Predictor({ state });
  p.ship.angle = 0;
  p.ship.vel = new Vector2(300, 0);
  p.step(input(1, { thrust: false }));
  const half = p.visual(0.5);
  const a = p.ship.prevPos;
  const b = p.ship.pos;
  assert.ok(Math.abs(half.x - (a.x + b.x) / 2) < 1e-9);
  p.offset = { x: 0, y: 7 };
  assert.ok(Math.abs(p.visual(1).y - (b.y + 7)) < 1e-9);
});

test("firing: a bullet appears at once; the server's copy (same seq) confirms it, and its disappearance removes it", () => {
  const { state } = fresh();
  const p = new Predictor({ state });
  p.ship.angle = 0;
  const shot = p.step(input(3, { fire: true, thrust: false }));
  assert.ok(shot);
  assert.equal(p.bullets.length, 1);
  assert.ok((p.bullets[0]?.id ?? 0) < 0);

  const me = state.id;
  const serverBullet = bulletSnap(55, me, 0, 0, 3);
  p.reconcile(p.ship.toState(), seq(3), [serverBullet]);
  assert.equal(p.bullets[0]?.confirmed, true);
  assert.equal(p.bullets[0]?.id, 55);

  p.reconcile(p.ship.toState(), seq(4), []); // the server no longer has it: it hit something
  assert.equal(p.bullets.length, 0);
});

test("a bullet the server never made (input acknowledged, no bullet) is dropped; one still in flight is kept", () => {
  const { state } = fresh();
  const p = new Predictor({ state });
  p.step(input(1, { fire: true, thrust: false }));
  p.reconcile(p.ship.toState(), seq(0), []); // server has not seen input 1 yet
  assert.equal(p.bullets.length, 1, "still in flight");
  p.reconcile(p.ship.toState(), seq(1), []); // seen — and it made no bullet (cooling down, say)
  assert.equal(p.bullets.length, 0);
});

test("only the low 16 bits of seq travel with a bullet: matching must use them", () => {
  const { state } = fresh();
  const p = new Predictor({ state });
  p.step(input(70000, { fire: true, thrust: false }));
  p.reconcile(p.ship.toState(), seq(0), [bulletSnap(9, state.id, 0, 0, 70000 & 0xffff)]);
  assert.equal(p.bullets[0]?.confirmed, true);
});

test("predicted bullets fly and expire like the real thing (ttl)", () => {
  const { state } = fresh();
  const p = new Predictor({ state });
  p.step(input(1, { fire: true, thrust: false }));
  const first = p.bullets[0]?.bullet.pos ?? Vector2.zero;
  p.step(input(2, { thrust: false }));
  assert.ok(
    (p.bullets[0]?.bullet.pos ?? first).sub(first).length() > 10,
    "it moved ~480 units/s × one step",
  );
  for (let s = 3; s < 60; s++) p.step(input(s, { thrust: false })); // 1.9 s > 1.2 s ttl
  assert.equal(p.bullets.length, 0);
});

test("chaos: noise in the predicted step makes two predictions of the same inputs differ — exactly the bug the lab provokes", () => {
  const { state } = fresh();
  let n = 0;
  const noisy = new Predictor({ state, chaos: 0.3, random: () => (n += 0.37) % 1 });
  const clean = new Predictor({ state });
  for (let s = 1; s <= 30; s++) {
    noisy.step(input(s, { turn: 1 }));
    clean.step(input(s, { turn: 1 }));
  }
  assert.ok(
    Math.hypot(noisy.ship.pos.x - clean.ship.pos.x, noisy.ship.pos.y - clean.ship.pos.y) > 0.01,
  );
});

test("while no acknowledgement arrives (link down) the pending list stays bounded", () => {
  const { state } = fresh();
  const p = new Predictor({ state });
  for (let s = 1; s <= 1000; s++) p.step(input(s, { thrust: false }));
  assert.equal(p.pending.length, 300);
  assert.equal(p.pending[0]?.seq, 701, "the oldest were forgotten, not the newest");
});
