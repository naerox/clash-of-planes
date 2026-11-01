import { test } from "vitest";
import assert from "node:assert/strict";
import {
  CLOSE,
  isFatalClose,
  parseClientMessage,
  parseServerControl,
  toClient,
  type ClientMessage,
} from "../src/protocol.ts";
import { entityId, tick } from "../src/brand.ts";

const j = (o: unknown): string => JSON.stringify(o);
const ok = (raw: string | Uint8Array, opts?: { maxBytes?: number }): ClientMessage => {
  const r = parseClientMessage(raw, opts);
  assert.ok(r.ok, JSON.stringify(r));
  return r.msg;
};
const bad = (raw: unknown, code: number, opts?: { maxBytes?: number }) => {
  const r = parseClientMessage(raw, opts);
  assert.ok(!r.ok, `should be rejected: ${String(raw)}`);
  assert.equal(r.code, code, r.reason);
  return r;
};

test("valid join / chat / leave", () => {
  assert.deepEqual(ok(j({ v: 1, type: "join", room: "belt-ab12", name: "  Ace " })), {
    type: "join",
    room: "belt-ab12",
    name: "Ace",
    codec: "binary",
  });
  assert.deepEqual(ok(j({ v: 1, type: "chat", text: " привіт, світе " })), {
    type: "chat",
    text: "привіт, світе",
  });
  assert.deepEqual(ok(j({ v: 1, type: "leave" })), { type: "leave" });
});

test("accepts a Buffer as well as a string", () => {
  ok(Buffer.from(j({ v: 1, type: "leave" })));
});

test("not JSON, or JSON that is not an object → 4000", () => {
  for (const raw of ["{nope", "", "[]", "null", "42", '"str"']) bad(raw, CLOSE.BAD_MESSAGE);
});

test("missing or wrong version → 4000", () => {
  bad(j({ type: "leave" }), CLOSE.BAD_MESSAGE);
  bad(j({ v: 2, type: "leave" }), CLOSE.BAD_MESSAGE);
  bad(j({ v: "1", type: "leave" }), CLOSE.BAD_MESSAGE);
});

test("unknown type → 4001, but a missing/non-string type → 4000", () => {
  bad(j({ v: 1, type: "teleport" }), CLOSE.UNKNOWN_TYPE);
  bad(j({ v: 1, type: "constructor" }), CLOSE.UNKNOWN_TYPE); // not an inherited property
  bad(j({ v: 1 }), CLOSE.BAD_MESSAGE);
  bad(j({ v: 1, type: 7 }), CLOSE.BAD_MESSAGE);
});

test("join: room id and name are checked", () => {
  const v = (extra: Record<string, unknown>) =>
    j({ v: 1, type: "join", room: "belt", name: "A", ...extra });
  bad(v({ room: "../etc" }), CLOSE.BAD_MESSAGE);
  bad(v({ room: "UPPER" }), CLOSE.BAD_MESSAGE);
  bad(v({ room: 5 }), CLOSE.BAD_MESSAGE);
  bad(v({ name: "" }), CLOSE.BAD_MESSAGE);
  bad(v({ name: "   " }), CLOSE.BAD_MESSAGE);
  bad(v({ name: "x".repeat(17) }), CLOSE.BAD_MESSAGE);
  bad(v({ name: "bell\u0007" }), CLOSE.BAD_MESSAGE);
  bad(v({ name: 12 }), CLOSE.BAD_MESSAGE);
  bad(j({ v: 1, type: "join", room: "belt" }), CLOSE.BAD_MESSAGE);
});

test("chat: length and characters", () => {
  const c = (text: unknown) => j({ v: 1, type: "chat", text });
  bad(c(""), CLOSE.BAD_MESSAGE);
  bad(c("x".repeat(201)), CLOSE.BAD_MESSAGE);
  bad(c("two\nlines"), CLOSE.BAD_MESSAGE);
  bad(j({ v: 1, type: "chat", text: { $ne: 1 } }), CLOSE.BAD_MESSAGE);
  ok(c("x".repeat(200)));
});

test("unexpected extra fields are a malformed message", () => {
  bad(j({ v: 1, type: "chat", text: "hi", admin: true }), CLOSE.BAD_MESSAGE);
  bad(j({ v: 1, type: "leave", why: "bored" }), CLOSE.BAD_MESSAGE);
});

test("oversize → 1009, measured in bytes not characters", () => {
  const r = bad("x".repeat(100), CLOSE.TOO_BIG, { maxBytes: 50 });
  assert.match(r.reason, /100 bytes/);
  // 30 Cyrillic letters are 60 bytes in UTF-8
  bad(j({ v: 1, type: "chat", text: "я".repeat(30) }), CLOSE.TOO_BIG, { maxBytes: 70 });
});

test("only protocol-violation codes are fatal for the reconnecting client", () => {
  for (const c of [1003, 1008, 1009, 4000, 4001, 4003, 4004])
    assert.equal(isFatalClose(c), true, String(c));
  for (const c of [1000, 1001, 1006, 1011, 1013]) assert.equal(isFatalClose(c), false, String(c));
});

test("join may choose the json codec; anything else is rejected", () => {
  const join = (codec: unknown) => j({ v: 1, type: "join", room: "belt-ab12", name: "A", codec });
  const codecOf = (raw: string): string | undefined => {
    const m = ok(raw);
    return m.type === "join" ? m.codec : undefined;
  };
  assert.equal(codecOf(join("json")), "json");
  assert.equal(codecOf(join("binary")), "binary");
  bad(join("protobuf"), CLOSE.BAD_MESSAGE);
});

test("input (JSON codec): shape and ranges are enforced", () => {
  const input = (extra: Record<string, unknown>) =>
    j({ v: 1, type: "input", seq: 1, tick: 0, thrust: true, turn: 0, fire: false, ...extra });
  assert.deepEqual(ok(input({ turn: -1 })), {
    type: "input",
    seq: 1,
    tick: 0,
    thrust: true,
    turn: -1,
    fire: false,
  });
  for (const bad_ of [
    { turn: 1000 }, // the speed hack from the lab text
    { turn: 0.5 },
    { turn: "1" },
    { seq: 0 },
    { seq: -3 },
    { seq: 1.5 },
    { seq: 2 ** 32 },
    { tick: -1 },
    { thrust: 1 },
    { fire: "yes" },
    { x: 500 }, // a position: never accepted
  ]) {
    bad(input(bad_), CLOSE.BAD_MESSAGE);
  }
});

test("ping and netsim", () => {
  assert.deepEqual(ok(j({ v: 1, type: "ping", t: 12.5 })), { type: "ping", t: 12.5 });
  bad(j({ v: 1, type: "ping", t: "now" }), CLOSE.BAD_MESSAGE);
  assert.deepEqual(ok(j({ v: 1, type: "netsim", latency: 100, jitter: 30, drop: 0.02 })), {
    type: "netsim",
    latency: 100,
    jitter: 30,
    drop: 0.02,
  });
  bad(j({ v: 1, type: "netsim", latency: 5000, jitter: 0, drop: 0 }), CLOSE.BAD_MESSAGE);
  bad(j({ v: 1, type: "netsim", latency: 0, jitter: 0, drop: 0.9 }), CLOSE.BAD_MESSAGE);
  bad(j({ v: 1, type: "netsim", latency: -1, jitter: 0, drop: 0 }), CLOSE.BAD_MESSAGE);
});

test("a Uint8Array (what ws hands the server) is accepted like a string", () => {
  ok(new TextEncoder().encode(j({ v: 1, type: "leave" })));
});

test("parseClientMessage never throws, whatever it is handed", () => {
  const junk: unknown[] = [
    undefined,
    null,
    42,
    {},
    [],
    () => 1,
    Symbol("x"),
    new Uint8Array([0xff, 0xfe, 0x00]),
    new Uint8Array(0),
    "\u0000",
    "{".repeat(5000),
    '{"v":1,"type":"join","room":{"toString":1},"name":[]}',
    '{"v":1,"type":"input","seq":1e999}',
  ];
  for (const raw of junk) {
    const r = parseClientMessage(raw);
    assert.equal(r.ok, false, String(raw));
  }
});

test("a frame that is neither text nor bytes is refused as unsupported (1003)", () => {
  bad(12345, CLOSE.UNSUPPORTED);
  bad({ type: "leave" }, CLOSE.UNSUPPORTED);
});

test("the server's control messages round-trip through the client's parser", () => {
  const joined = toClient.joined({
    type: "joined",
    room: { id: "belt-ab12", name: "Belt", players: 1, maxPlayers: 8, arena: { asteroids: 3 } },
    you: "p1",
    shipId: entityId(5),
    players: [{ id: "p1", name: "Ace", shipId: entityId(5) }],
    seed: 42,
    tickRate: 30,
    tick: tick(0),
    codec: "binary",
  });
  const r = parseServerControl(j(joined));
  assert.ok(r.ok);
  const { v, ...withoutVersion } = joined;
  assert.equal(v, 1);
  assert.deepEqual(r.msg, withoutVersion);
  for (const msg of [
    toClient.roster([]),
    toClient.chat({ from: { id: "p1", name: "Ace" }, text: "hi", t: 1 }),
    toClient.error("room_full", "room is full"),
  ]) {
    assert.ok(parseServerControl(j(msg)).ok, msg.type);
  }
});

test("the client rejects a server message of the wrong shape instead of trusting it", () => {
  assert.equal(parseServerControl(j({ v: 1, type: "joined" })).ok, false);
  assert.equal(parseServerControl(j({ v: 1, type: "roster", players: [{ id: 1 }] })).ok, false);
  assert.equal(parseServerControl(j({ v: 1, type: "error", code: 5, message: "x" })).ok, false);
  assert.equal(parseServerControl(j({ v: 9, type: "roster", players: [] })).ok, false);
  assert.equal(parseServerControl("{nope").ok, false);
  assert.equal(parseServerControl(new Uint8Array(3)).ok, false);
});
