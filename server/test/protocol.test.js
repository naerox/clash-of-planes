import test from "node:test";
import assert from "node:assert/strict";
import { CLOSE, isFatalClose, validate } from "../src/protocol.js";

const j = (o) => JSON.stringify(o);
const ok = (raw, opts) => {
  const r = validate(raw, opts);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.msg;
};
const bad = (raw, code, opts) => {
  const r = validate(raw, opts);
  assert.equal(r.ok, false, `should be rejected: ${raw}`);
  assert.equal(r.code, code, r.reason);
  return r;
};

test("valid join / chat / leave", () => {
  assert.deepEqual(ok(j({ v: 1, type: "join", room: "belt-ab12", name: "  Ace " })), {
    type: "join",
    room: "belt-ab12",
    name: "Ace",
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
  const v = (extra) => j({ v: 1, type: "join", room: "belt", name: "A", ...extra });
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
  const c = (text) => j({ v: 1, type: "chat", text });
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
    assert.equal(isFatalClose(c), true, c);
  for (const c of [1000, 1001, 1006, 1011, 1013]) assert.equal(isFatalClose(c), false, c);
});
