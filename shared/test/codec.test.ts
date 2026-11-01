import test from "node:test";
import assert from "node:assert/strict";
import {
  BINARY_SIZES,
  CodecError,
  Rng,
  angleDelta,
  binaryCodec,
  entityId,
  getCodec,
  jsonCodec,
  seq,
  shotSeq,
  tick,
  type GameMessage,
  type InputMessage,
  type PongMessage,
  type ShipSnap,
  type SimEvent,
  type SnapshotMessage,
} from "../src/index.ts";
import { inputMsg } from "./helpers.ts";

const near = (a: number, b: number, tol: number, what: string): void =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

interface SnapshotShape {
  ships?: number;
  bullets?: number;
  asteroids?: number;
  pickups?: number;
  events?: number;
  you?: boolean;
}

/** One of four event shapes, chosen by index so every shape appears. */
function eventAt(rng: Rng, i: number): SimEvent {
  const id = () => entityId(1 + rng.int(60000));
  const x = rng.next() * 1600;
  const y = rng.next() * 900;
  switch (i % 4) {
    case 0:
      return { type: "fired", shooterId: id(), x, y };
    case 1:
      return { type: "hit", target: "ship", targetId: id(), x, y, damage: 12 };
    case 2:
      return { type: "exploded", kind: "asteroid", id: id(), x, y, radius: 30 };
    default:
      return { type: "hit", target: "asteroid", targetId: entityId(5), x: 1, y: 2, damage: 25 };
  }
}

/** A random but valid logical snapshot. */
function randomSnapshot(
  rng: Rng,
  {
    ships = 3,
    bullets = 12,
    asteroids = 9,
    pickups = 2,
    events = 4,
    you = true,
  }: SnapshotShape = {},
): SnapshotMessage {
  const f = (max: number): number => rng.next() * max;
  const id = () => entityId(1 + rng.int(60000));
  return {
    type: "snapshot",
    tick: tick(rng.int(2 ** 31)),
    ack: seq(rng.int(2 ** 31)),
    you: you
      ? {
          id: id(),
          x: f(1600),
          y: f(900),
          vx: f(800) - 400,
          vy: f(800) - 400,
          angle: f(6.2) - 3.1,
          hp: rng.int(101),
          thrusting: rng.chance(0.5),
          cooldown: f(0.25),
          rapid: f(6),
          respawn: rng.chance(0.8) ? 0 : f(2),
          score: rng.int(1000),
        }
      : null,
    ships: Array.from({ length: ships }, () => ({
      kind: "ship" as const,
      id: id(),
      x: f(1600),
      y: f(900),
      angle: f(6.2) - 3.1,
      hp: rng.int(101),
      thrusting: rng.chance(0.5),
      dead: rng.chance(0.2),
      rapid: rng.chance(0.2),
      score: rng.int(1000),
    })),
    bullets: Array.from({ length: bullets }, () => ({
      kind: "bullet" as const,
      id: id(),
      owner: id(),
      x: f(1600),
      y: f(900),
      seq: shotSeq(rng.int(65536)),
    })),
    asteroids: Array.from({ length: asteroids }, () => ({
      kind: "asteroid" as const,
      id: id(),
      x: f(1600),
      y: f(900),
      angle: f(6.2) - 3.1,
      radius: 20 + rng.int(27),
      hunter: rng.chance(0.2),
    })),
    pickups: Array.from({ length: pickups }, () => ({
      kind: "pickup" as const,
      id: id(),
      x: f(1600),
      y: f(900),
      variant: rng.chance(0.5) ? ("shield" as const) : ("rapid" as const),
    })),
    events: Array.from({ length: events }, (_, i) => eventAt(rng, i)),
  };
}

function emptySnapshot(over: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    type: "snapshot",
    tick: tick(1),
    ack: seq(0),
    you: null,
    ships: [],
    bullets: [],
    asteroids: [],
    pickups: [],
    events: [],
    ...over,
  };
}

function shipAt(angle: number): ShipSnap {
  return {
    kind: "ship",
    id: entityId(1),
    x: 0,
    y: 0,
    angle,
    hp: 1,
    thrusting: false,
    dead: false,
    rapid: false,
    score: 0,
  };
}

/** Narrows a decoded `GameMessage` to a snapshot, failing the test otherwise. */
function snapshotOf(m: GameMessage): SnapshotMessage {
  assert.ok(m.type === "snapshot", `expected a snapshot, got ${m.type}`);
  return m;
}

const rec = (o: object): Record<string, unknown> => ({ ...o });

/** Compares the named numeric fields to within `tol(want)`. */
function nearFields(got: object, want: object, keys: readonly string[], what: string, tol = 1e-4) {
  const g = rec(got);
  const w = rec(want);
  for (const k of keys) near(Number(g[k]), Number(w[k]), Math.max(tol, 0), `${what}.${k}`);
}

function sameFields(got: object, want: object, keys: readonly string[], what: string) {
  const g = rec(got);
  const w = rec(want);
  for (const k of keys) assert.equal(g[k], w[k], `${what}.${k}`);
}

function assertSnapshotsClose(gotMsg: GameMessage, wantMsg: GameMessage): void {
  const got = snapshotOf(gotMsg);
  const want = snapshotOf(wantMsg);
  assert.equal(got.tick, want.tick);
  assert.equal(got.ack, want.ack);
  if (want.you) {
    assert.ok(got.you);
    for (const k of ["x", "y", "vx", "vy", "angle", "cooldown", "rapid", "respawn"] as const) {
      const w = want.you[k];
      near(got.you[k], w, Math.max(1e-6, Math.abs(w) * 1.2e-7), `you.${k}`);
    }
    sameFields(got.you, want.you, ["id", "hp", "thrusting", "score"], "you");
  } else assert.equal(got.you, null);

  assert.equal(got.ships.length, want.ships.length);
  want.ships.forEach((s, i) => {
    const g = got.ships[i];
    assert.ok(g);
    nearFields(g, s, ["x", "y"], "ship");
    near(g.angle, s.angle, 0.0005, "ship.angle (1/1000 rad)");
    sameFields(g, s, ["kind", "id", "hp", "thrusting", "dead", "rapid", "score"], "ship");
  });
  assert.equal(got.bullets.length, want.bullets.length);
  want.bullets.forEach((b, i) => {
    const g = got.bullets[i];
    assert.ok(g);
    near(g.x, b.x, 1e-4, "bullet.x");
    sameFields(g, b, ["kind", "id", "owner", "seq"], "bullet");
  });
  want.asteroids.forEach((a, i) => {
    const g = got.asteroids[i];
    assert.ok(g);
    near(g.angle, a.angle, 0.0005, "asteroid.angle");
    sameFields(g, a, ["kind", "id", "radius", "hunter"], "asteroid");
  });
  assert.deepEqual(
    got.pickups.map((p) => [p.id, p.variant]),
    want.pickups.map((p) => [p.id, p.variant]),
  );
  assert.deepEqual(
    got.events.map((e) => e.type),
    want.events.map((e) => e.type),
  );
  want.events.forEach((e, i) => {
    const g = got.events[i];
    assert.ok(g);
    const gr = rec(g);
    for (const [k, w] of Object.entries(e)) {
      if (typeof w === "number" && !Number.isInteger(w)) near(Number(gr[k]), w, 1e-4, `event.${k}`);
      else assert.equal(gr[k], w, `event.${k}`);
    }
  });
}

test("INPUT round-trips exactly, and is 12 bytes", () => {
  const msg = inputMsg({ seq: seq(123456), tick: tick(99), thrust: true, turn: -1, fire: true });
  const bytes = binaryCodec.encode(msg);
  assert.equal(bytes.length, 12);
  assert.equal(bytes.length, BINARY_SIZES.input);
  assert.deepEqual(binaryCodec.decode(bytes), msg);
  for (const turn of [-1, 0, 1] as const) {
    for (const thrust of [true, false]) {
      for (const fire of [true, false]) {
        const m = inputMsg({ thrust, turn, fire });
        assert.deepEqual(binaryCodec.decode(binaryCodec.encode(m)), m);
      }
    }
  }
});

test("little-endian, written down and checked byte by byte", () => {
  const bytes = binaryCodec.encode(
    inputMsg({ seq: seq(0x01020304), tick: tick(0x0a0b0c0d), thrust: true, turn: 1 }),
  );
  assert.deepEqual(
    [...bytes],
    [
      1 /* type */, 1 /* version */, 0x04, 0x03, 0x02, 0x01 /* seq, LSB first */, 0x0d, 0x0c, 0x0b,
      0x0a /* tick */, 0b01 /* flags */, 1 /* turn */,
    ],
  );
  // and the same bytes read with the OTHER byte order give a different number: that is the point
  const v = new DataView(bytes.buffer);
  assert.equal(v.getUint32(2, true), 0x01020304);
  assert.equal(v.getUint32(2, false), 0x04030201);
});

test("PING / PONG", () => {
  assert.deepEqual(binaryCodec.decode(binaryCodec.encode({ type: "ping", t: 123456789 })), {
    type: "ping",
    t: 123456789,
  });
  const pong: PongMessage = { type: "pong", t: 4000000000, tick: tick(777) };
  assert.deepEqual(binaryCodec.decode(binaryCodec.encode(pong)), pong);
  assert.equal(binaryCodec.encode({ type: "ping", t: 1 }).length, 6);
  assert.equal(binaryCodec.encode(pong).length, 10);
});

test("SNAPSHOT round-trips within the documented quantisation (1/1000 rad, f32)", () => {
  const rng = new Rng(2026);
  for (let n = 0; n < 200; n++) {
    const snap = randomSnapshot(rng, {
      ships: rng.int(9),
      bullets: rng.int(40),
      asteroids: rng.int(30),
      pickups: rng.int(4),
      events: rng.int(8),
      you: rng.chance(0.8),
    });
    assertSnapshotsClose(binaryCodec.decode(binaryCodec.encode(snap)), snap);
  }
});

test("SNAPSHOT size is exactly header + you + records (the spec's arithmetic)", () => {
  const snap = randomSnapshot(new Rng(1), {
    ships: 3,
    bullets: 12,
    asteroids: 9,
    pickups: 2,
    events: 4,
  });
  const events = snap.events.reduce((n, e) => n + BINARY_SIZES.events[e.type], 0);
  const expected =
    11 + 38 + (1 + 3 * 16) + (2 + 12 * 14) + (1 + 9 * 14) + (1 + 2 * 11) + (1 + events);
  assert.equal(binaryCodec.encode(snap).length, expected);
  assert.equal(
    binaryCodec.encode(randomSnapshot(new Rng(1), { you: false })).length,
    binaryCodec.encode(snap).length - 38,
  );
});

test("the angle's quantisation error never exceeds 0.0005 rad, even at the edges and for unwrapped angles", () => {
  let worst = 0;
  for (let a = -3.1416; a <= 3.1416; a += 0.00123) {
    const snap = emptySnapshot({ ships: [shipAt(a)] });
    // +π and −π are the same direction: compare the SHORTEST rotation between them
    const back = snapshotOf(binaryCodec.decode(binaryCodec.encode(snap))).ships[0]?.angle ?? NaN;
    worst = Math.max(worst, Math.abs(angleDelta(a, back)));
  }
  assert.ok(worst <= 0.0005 + 1e-12, `worst error ${worst}`);
  // an asteroid's angle grows without bound in the sim: the codec wraps it first
  const rock = emptySnapshot({
    asteroids: [
      { kind: "asteroid", id: entityId(1), x: 0, y: 0, angle: 1000.5, radius: 30, hunter: false },
    ],
  });
  const decoded =
    snapshotOf(binaryCodec.decode(binaryCodec.encode(rock))).asteroids[0]?.angle ?? NaN;
  near(Math.cos(decoded), Math.cos(1000.5), 0.001, "same direction after wrapping");
});

test("JSON codec: round-trip is exact, and the version field never leaks into the message", () => {
  const rng = new Rng(7);
  const snap = randomSnapshot(rng);
  const text = jsonCodec.encode(snap);
  assert.equal(typeof text, "string");
  assert.deepEqual(jsonCodec.decode(text), snap);
  assert.ok(JSON.parse(text).v === 1);
  const input = inputMsg({ seq: seq(5), tick: tick(4), turn: 1, fire: true });
  assert.deepEqual(jsonCodec.decode(jsonCodec.encode(input)), input);
});

test("both codecs carry the same logical message", () => {
  const snap = randomSnapshot(new Rng(99));
  assertSnapshotsClose(
    binaryCodec.decode(binaryCodec.encode(snap)),
    jsonCodec.decode(jsonCodec.encode(snap)),
  );
});

test("binary is much smaller than JSON, both up and down", () => {
  const snap = randomSnapshot(new Rng(3), {
    ships: 3,
    bullets: 10,
    asteroids: 9,
    pickups: 1,
    events: 3,
  });
  const json = new TextEncoder().encode(jsonCodec.encode(snap)).length;
  const bin = binaryCodec.encode(snap).length;
  assert.ok(json / bin > 4, `JSON ${json} B vs binary ${bin} B`);
  const input = inputMsg({
    seq: seq(123456),
    tick: tick(99999),
    thrust: true,
    turn: -1,
    fire: true,
  });
  assert.ok(new TextEncoder().encode(jsonCodec.encode(input)).length / 12 > 5);
});

test("decoders reject garbage with a CodecError — never anything else, never a bad read", () => {
  const rng = new Rng(1234);
  const good = binaryCodec.encode(randomSnapshot(new Rng(5)));
  const attempts: Uint8Array[] = [];
  attempts.push(
    new Uint8Array(0),
    new Uint8Array([2]),
    new Uint8Array([2, 1]),
    new Uint8Array([9, 1, 0, 0]),
  );
  for (let cut = 0; cut < good.length; cut += 7) attempts.push(good.slice(0, cut)); // truncations
  for (let n = 0; n < 500; n++) {
    attempts.push(Uint8Array.from({ length: rng.int(80) }, () => rng.int(256)));
    const mutated = good.slice();
    mutated[rng.int(mutated.length)] = rng.int(256);
    attempts.push(mutated);
  }
  let rejected = 0;
  for (const bytes of attempts) {
    try {
      binaryCodec.decode(bytes);
    } catch (err) {
      assert.ok(err instanceof CodecError, `unexpected ${String(err)}`);
      rejected++;
    }
  }
  assert.ok(rejected > 400, `${rejected} of ${attempts.length} rejected`);
});

test("wrong version and wrong type are refused", () => {
  const input = binaryCodec.encode(inputMsg());
  const v2 = input.slice();
  v2[1] = 2;
  assert.throws(() => binaryCodec.decode(v2), /version/);
  const alien = input.slice();
  alien[0] = 77;
  assert.throws(() => binaryCodec.decode(alien), /unknown message type/);
});

test("a decoded INPUT is validated like a JSON one: turn 5 / seq 0 in the bytes are rejected", () => {
  const bytes = binaryCodec.encode(inputMsg());
  const cheat = bytes.slice();
  cheat[11] = 5; // turn = 5
  assert.throws(() => binaryCodec.decode(cheat), /turn/);
  const noSeq = bytes.slice();
  noSeq.fill(0, 2, 6); // seq = 0
  assert.throws(() => binaryCodec.decode(noSeq), /seq/);
});

test("decode accepts a plain ArrayBuffer (a browser's binaryType) and a Node Buffer slice with an offset", () => {
  const msg: PongMessage = { type: "pong", t: 5, tick: tick(6) };
  const bytes = binaryCodec.encode(msg);
  assert.deepEqual(binaryCodec.decode(new Uint8Array(bytes).buffer), msg);
  const padded = new Uint8Array(20);
  padded.set(bytes, 7);
  assert.deepEqual(
    binaryCodec.decode(padded.subarray(7, 7 + bytes.length)),
    msg,
    "a view into the middle of a bigger buffer",
  );
});

test("JSON decode rejects the wrong version, unknown types and malformed snapshots", () => {
  assert.throws(() => jsonCodec.decode("{"), CodecError);
  assert.throws(() => jsonCodec.decode('{"v":2,"type":"ping","t":1}'), /version/);
  assert.throws(() => jsonCodec.decode('{"v":1,"type":"join"}'), /unknown type/);
  assert.throws(() => jsonCodec.decode('{"v":1,"type":"snapshot","ships":1}'), CodecError);
  assert.throws(
    () =>
      jsonCodec.decode(
        '{"v":1,"type":"input","seq":1,"tick":0,"thrust":true,"turn":9,"fire":false}',
      ),
    /turn/,
  );
});

test("getCodec", () => {
  assert.equal(getCodec("binary"), binaryCodec);
  assert.equal(getCodec("json"), jsonCodec);
  // @ts-expect-error "xml" is not a codec name: the compiler rejects it before the runtime does
  assert.throws(() => getCodec("xml"), RangeError);
  assert.equal(binaryCodec.binary, true);
  assert.equal(jsonCodec.binary, false);
});

test("a decoded binary snapshot is rejected when it has trailing bytes or a non-finite float", () => {
  const good = binaryCodec.encode(randomSnapshot(new Rng(8)));
  const longer = new Uint8Array(good.length + 1);
  longer.set(good);
  assert.throws(() => binaryCodec.decode(longer), /trailing/);
  const nan = binaryCodec.encode(emptySnapshot({ ships: [shipAt(0)] }));
  new DataView(nan.buffer).setFloat32(11 + 1 + 2, Number.NaN, true); // ship.x
  assert.throws(() => binaryCodec.decode(nan), /non-finite/);
});

test("JSON snapshots are validated field by field, so a wrong type cannot reach the game", () => {
  const snap = randomSnapshot(new Rng(10));
  const text = jsonCodec.encode(snap);
  assert.doesNotThrow(() => jsonCodec.decode(text));
  const wrong = text.replace('"kind":"ship"', '"kind":"submarine"');
  assert.throws(() => jsonCodec.decode(wrong), CodecError);
  const huge = text.replace(/"id":\d+/, '"id":999999');
  assert.throws(() => jsonCodec.decode(huge), CodecError);
});

// a type-level check: this must compile, and each `InputMessage` must carry a branded seq
const typed: InputMessage = inputMsg();
void typed;
