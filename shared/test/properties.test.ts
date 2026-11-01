// Property-based tests (fast-check): instead of examples, state an invariant and let the library
// try thousands of generated inputs — and shrink a failure to the smallest one that still fails.

import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  ARENA,
  BINARY_SIZES,
  CodecError,
  SHIP_PARAMS,
  Ship,
  Vector2,
  World,
  angleDelta,
  binaryCodec,
  entityId,
  jsonCodec,
  parseClientMessage,
  scenarioHash,
  seq,
  shotSeq,
  tick,
  type ClientMessage,
  type GameMessage,
  type SimEvent,
  type SnapshotMessage,
  type Turn,
} from "../src/index.ts";

// ── generators: every VALID message the protocol knows ───────────────────────────────

const u16 = fc.integer({ min: 0, max: 0xffff });
const u32 = fc.integer({ min: 0, max: 0xffffffff });
const id = u16.map(entityId);
// `+ 0` turns -0 into 0. fast-check found this on its own: JSON.stringify(-0) is "0", so a JSON
// round trip cannot return -0 (the binary codec keeps it). A real property of the format, not a bug.
const real = (min: number, max: number) => fc.double({ min, max, noNaN: true }).map((n) => n + 0);
const coord = (max: number) => real(0, max);
const f32able = real(-2000, 2000);
const turn: fc.Arbitrary<Turn> = fc.constantFrom(-1, 0, 1);

const inputMessage = fc.record({
  type: fc.constant("input" as const),
  seq: fc.integer({ min: 1, max: 0xffffffff }).map(seq),
  tick: u32.map(tick),
  thrust: fc.boolean(),
  turn,
  fire: fc.boolean(),
});

const simEvent: fc.Arbitrary<SimEvent> = fc.oneof(
  fc.record({ type: fc.constant("fired" as const), shooterId: id, x: coord(1600), y: coord(900) }),
  fc.record({
    type: fc.constant("hit" as const),
    target: fc.constantFrom("ship" as const, "asteroid" as const),
    targetId: id,
    x: coord(1600),
    y: coord(900),
    damage: fc.integer({ min: 0, max: 255 }),
  }),
  fc.record({
    type: fc.constant("exploded" as const),
    kind: fc.constantFrom("ship" as const, "asteroid" as const),
    id,
    x: coord(1600),
    y: coord(900),
    radius: fc.integer({ min: 0, max: 255 }),
  }),
);

const snapshot: fc.Arbitrary<SnapshotMessage> = fc.record({
  type: fc.constant("snapshot" as const),
  tick: u32.map(tick),
  ack: u32.map(seq),
  you: fc.option(
    fc.record({
      id,
      x: coord(1600),
      y: coord(900),
      vx: f32able,
      vy: f32able,
      angle: real(-10, 10),
      hp: fc.integer({ min: 0, max: 255 }),
      cooldown: coord(1),
      rapid: coord(10),
      respawn: coord(10),
      score: u16,
      thrusting: fc.boolean(),
    }),
    { nil: null },
  ),
  ships: fc.array(
    fc.record({
      kind: fc.constant("ship" as const),
      id,
      x: coord(1600),
      y: coord(900),
      angle: real(-50, 50),
      hp: fc.integer({ min: 0, max: 255 }),
      thrusting: fc.boolean(),
      dead: fc.boolean(),
      rapid: fc.boolean(),
      score: u16,
    }),
    { maxLength: 20 },
  ),
  bullets: fc.array(
    fc.record({
      kind: fc.constant("bullet" as const),
      id,
      owner: id,
      x: coord(1600),
      y: coord(900),
      seq: u16.map(shotSeq),
    }),
    { maxLength: 40 },
  ),
  asteroids: fc.array(
    fc.record({
      kind: fc.constant("asteroid" as const),
      id,
      x: coord(1600),
      y: coord(900),
      angle: real(-50, 50),
      radius: fc.integer({ min: 0, max: 255 }),
      hunter: fc.boolean(),
    }),
    { maxLength: 20 },
  ),
  pickups: fc.array(
    fc.record({
      kind: fc.constant("pickup" as const),
      id,
      x: coord(1600),
      y: coord(900),
      variant: fc.constantFrom("shield" as const, "rapid" as const),
    }),
    { maxLength: 6 },
  ),
  events: fc.array(simEvent, { maxLength: 20 }),
});

const gameMessage: fc.Arbitrary<GameMessage> = fc.oneof(
  inputMessage,
  snapshot,
  fc.record({ type: fc.constant("ping" as const), t: u32 }),
  fc.record({ type: fc.constant("pong" as const), t: u32, tick: u32.map(tick) }),
);

/** Is `got` what `want` turns into after the wire? Integers exactly, floats to f32 precision, angles to 1/1000 rad. */
function closeTo(got: unknown, want: unknown, path = ""): void {
  if (typeof want === "number") {
    expect(typeof got, path).toBe("number");
    const g = Number(got);
    if (path.endsWith("angle") && !path.startsWith("you")) {
      // ships/asteroids: i16 in 1/1000 rad, wrapped into ±π (±π are the same direction)
      expect(Math.abs(angleDelta(want, g)), path).toBeLessThanOrEqual(0.0006);
    } else if (Number.isInteger(want)) expect(g, path).toBe(want);
    else expect(Math.abs(g - want), path).toBeLessThanOrEqual(1e-3 + Math.abs(want) * 1e-6);
  } else if (Array.isArray(want)) {
    expect(Array.isArray(got), path).toBe(true);
    const g = got as unknown[];
    expect(g.length, path).toBe(want.length);
    want.forEach((w, i) => closeTo(g[i], w, `${path}[${i}]`));
  } else if (typeof want === "object" && want !== null) {
    const g = got as Record<string, unknown>;
    expect(Object.keys(g).sort(), path).toEqual(Object.keys(want).sort());
    for (const [k, v] of Object.entries(want)) closeTo(g[k], v, path ? `${path}.${k}` : k);
  } else expect(got, path).toBe(want);
}

describe("codec properties", () => {
  test("binary: decode(encode(m)) is m, up to the documented rounding", () => {
    fc.assert(
      fc.property(gameMessage, (m) => {
        closeTo(binaryCodec.decode(binaryCodec.encode(m)), m);
      }),
      { numRuns: 400 },
    );
  });

  test("json: decode(encode(m)) is exactly m", () => {
    fc.assert(
      fc.property(gameMessage, (m) => {
        expect(jsonCodec.decode(jsonCodec.encode(m))).toEqual(m);
      }),
      { numRuns: 200 },
    );
  });

  test("binary: the frame length is exactly what the format description says", () => {
    const expected = (m: GameMessage): number => {
      switch (m.type) {
        case "input":
          return BINARY_SIZES.input;
        case "ping":
          return BINARY_SIZES.ping;
        case "pong":
          return BINARY_SIZES.pong;
        case "snapshot":
          return (
            BINARY_SIZES.snapshotHeader +
            (m.you ? BINARY_SIZES.you : 0) +
            1 +
            m.ships.length * BINARY_SIZES.ship +
            2 +
            m.bullets.length * BINARY_SIZES.bullet +
            1 +
            m.asteroids.length * BINARY_SIZES.asteroid +
            1 +
            m.pickups.length * BINARY_SIZES.pickup +
            1 +
            m.events.reduce((n, e) => n + BINARY_SIZES.events[e.type], 0)
          );
        default: {
          const unreachable: never = m;
          return unreachable;
        }
      }
    };
    fc.assert(
      fc.property(gameMessage, (m) => {
        expect(binaryCodec.encode(m).length).toBe(expected(m));
      }),
      { numRuns: 300 },
    );
  });

  test("binary: arbitrary bytes give a message or a CodecError — never anything else", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => {
        try {
          binaryCodec.decode(bytes);
        } catch (err) {
          expect(err).toBeInstanceOf(CodecError);
        }
      }),
      { numRuns: 1000 },
    );
  });

  test("binary: a valid frame with bytes flipped or cut off is still handled (CodecError or a message)", () => {
    fc.assert(
      fc.property(
        snapshot,
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 8 }),
        fc.nat(),
        (m, flips, cut) => {
          const bytes = binaryCodec.encode(m).slice();
          for (const [at, value] of flips) bytes[at % bytes.length] = value;
          const mangled = bytes.subarray(0, cut % (bytes.length + 1));
          try {
            binaryCodec.decode(mangled);
          } catch (err) {
            expect(err).toBeInstanceOf(CodecError);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("parseClientMessage properties", () => {
  const validClient: fc.Arbitrary<ClientMessage> = fc.oneof(
    fc.record({
      type: fc.constant("join" as const),
      room: fc.stringMatching(/^[a-z0-9-]{1,48}$/),
      name: fc.stringMatching(/^[A-Za-z0-9_]{1,16}$/),
      codec: fc.constantFrom("binary" as const, "json" as const),
    }),
    fc.record({
      type: fc.constant("chat" as const),
      text: fc
        .stringMatching(/^[a-zA-Z0-9 ,.!?]{1,100}$/)
        .filter((t) => t.trim() !== "")
        .map((t) => t.trim()),
    }),
    fc.constant({ type: "leave" as const }),
    inputMessage,
    fc.record({ type: fc.constant("ping" as const), t: coord(1e9) }),
    fc.record({
      type: fc.constant("netsim" as const),
      latency: fc.double({ min: 0, max: 1000, noNaN: true }),
      jitter: fc.double({ min: 0, max: 500, noNaN: true }),
      drop: fc.double({ min: 0, max: 0.5, noNaN: true }),
    }),
  );

  test("accepts every generated valid message, and returns it unchanged", () => {
    fc.assert(
      fc.property(validClient, (m) => {
        const r = parseClientMessage(JSON.stringify({ v: 1, ...m }));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.msg).toEqual(m);
      }),
      { numRuns: 500 },
    );
  });

  /** Each mutation turns a valid message into one that must be refused. */
  const mutations: [string, (o: Record<string, unknown>) => Record<string, unknown>][] = [
    ["an extra field", (o) => ({ ...o, admin: true })],
    ["a wrong protocol version", (o) => ({ ...o, v: 2 })],
    ["no version", ({ v: _v, ...rest }) => (void _v, rest)],
    ["an unknown type", (o) => ({ ...o, type: "teleport" })],
    ["no type", ({ type: _t, ...rest }) => (void _t, rest)],
  ];

  test.each(mutations)("rejects a valid message with %s", (_name, mutate) => {
    fc.assert(
      fc.property(validClient, (m) => {
        const r = parseClientMessage(JSON.stringify(mutate({ v: 1, ...m })));
        expect(r.ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  test("rejects a valid message with any ONE required field replaced by the wrong kind of value", () => {
    fc.assert(
      fc.property(
        validClient.filter((m) => Object.keys(m).length > 1),
        fc.nat(),
        fc.constantFrom<unknown>(null, "x", [], {}, true, Number.POSITIVE_INFINITY),
        (m, which, junk) => {
          const fields = Object.keys(m).filter((k) => k !== "type");
          const field = fields[which % fields.length] ?? "";
          const original = (m as Record<string, unknown>)[field];
          fc.pre(typeof junk !== typeof original || junk === null || Array.isArray(junk));
          fc.pre(!(typeof original === "string" && junk === "x" && field !== "codec"));
          const r = parseClientMessage(JSON.stringify({ v: 1, ...m, [field]: junk }));
          expect(r.ok).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  test("never throws, whatever it is given", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.uint8Array(), fc.anything()), (raw) => {
        expect(() => parseClientMessage(raw)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});

describe("simulation properties", () => {
  const controls = fc.record({ turn, thrust: fc.boolean() });

  test("a ship never leaves the arena, and never exceeds its top speed, over 1000 random steps", () => {
    fc.assert(
      fc.property(
        fc.array(controls, { minLength: 1000, maxLength: 1000 }),
        coord(ARENA.width),
        coord(ARENA.height),
        (inputs, x, y) => {
          const ship = new Ship(new Vector2(x, y));
          for (const c of inputs) {
            ship.integrate(c, 1 / 30);
            expect(ship.pos.x).toBeGreaterThanOrEqual(0);
            expect(ship.pos.x).toBeLessThan(ARENA.width);
            expect(ship.pos.y).toBeGreaterThanOrEqual(0);
            expect(ship.pos.y).toBeLessThan(ARENA.height);
            expect(ship.vel.length()).toBeLessThanOrEqual(SHIP_PARAMS.maxSpeed + 1e-9);
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  test("determinism: the same seed and the same steps give the same hash", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 }),
        fc.integer({ min: 1, max: 150 }),
        (seed, steps) => {
          expect(scenarioHash({ seed, steps })).toBe(scenarioHash({ seed, steps }));
        },
      ),
      { numRuns: 15 },
    );
  });

  test("a world is driven by its seed: two different seeds almost never agree", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 30 }), (seed) => {
        const a = new World({ seed }).populate();
        const b = new World({ seed: seed + 1 }).populate();
        const positions = (w: World) => [...w].map((e) => `${e.pos.x},${e.pos.y}`).join(";");
        expect(positions(a)).not.toBe(positions(b));
      }),
      { numRuns: 50 },
    );
  });

  test("Vector2: rotation keeps length; add and sub undo each other", () => {
    const v = fc.record({
      x: fc.double({ min: -1e4, max: 1e4, noNaN: true }),
      y: fc.double({ min: -1e4, max: 1e4, noNaN: true }),
    });
    fc.assert(
      fc.property(v, v, fc.double({ min: -10, max: 10, noNaN: true }), (a, b, r) => {
        const va = new Vector2(a.x, a.y);
        const vb = new Vector2(b.x, b.y);
        expect(va.rotate(r).length()).toBeCloseTo(va.length(), 6);
        const back = va.add(vb).sub(vb);
        expect(back.x).toBeCloseTo(va.x, 6);
        expect(back.y).toBeCloseTo(va.y, 6);
      }),
    );
  });
});

describe("the Notes' experiment 5", () => {
  test("float32 survives Math.fround, a generated double does not (the counterexample is shrunk)", () => {
    expect(() =>
      fc.assert(fc.property(fc.float({ noNaN: true }), (x) => Math.fround(x) === x)),
    ).not.toThrow();
    let message = "";
    try {
      fc.assert(fc.property(fc.double({ noNaN: true }), (x) => Math.fround(x) === x));
    } catch (err) {
      message = String(err);
    }
    expect(message).toMatch(/Counterexample/);
  });
});
