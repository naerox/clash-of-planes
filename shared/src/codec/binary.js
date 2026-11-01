// The binary wire format, version 1 — a SPEC first, code second.
//
// Rules for every message:
//   * little-endian everywhere (DataView calls pass `true`): the byte order of x86 and ARM,
//     so no endian swap on the machines we run on — but fixed in writing, not left to the CPU
//   * byte 0 = message type, byte 1 = format version (1). A decoder refuses any other version.
//   * integers are unsigned unless the name says `i`; `f32` is an IEEE-754 float
//   * angles travel as i16 in 1/1000 radian: the range ±π needs ±3142, so 2 bytes instead of
//     4; the worst rounding error is 0.0005 rad = 0.029°, i.e. 0.9 units at 1000 units away
//   * "count"-prefixed lists are followed by exactly that many records, back to back
//
// ── 1  INPUT  client → server   (12 bytes) ─────────────────────────────────────────────
//   0  u8   type = 1
//   1  u8   version = 1
//   2  u32  seq          the client's input counter
//   6  u32  tick         newest server tick the client has received
//   10 u8   flags        bit0 thrust, bit1 fire
//   11 i8   turn         -1, 0 or 1
//
// ── 2  SNAPSHOT  server → client ───────────────────────────────────────────────────────
//   0  u8   type = 2
//   1  u8   version = 1
//   2  u32  tick         server tick this state belongs to
//   6  u32  ack          last INPUT seq the server applied for THIS client
//   10 u8   flags        bit0 = a YOUR-SHIP block follows
//   [YOUR SHIP — 38 bytes, full precision, because the client re-simulates from it]
//        u16 id; f32 x, y, vx, vy, angle; u8 hp; u8 flags(bit0 thrusting);
//        f32 cooldown, rapid, respawn; u16 score
//   u8  nShips,     then each ship (the OTHER players), 16 bytes:
//        u16 id; f32 x, y; i16 angle; u8 hp; u8 flags(bit0 thrusting, bit1 dead, bit2 rapid);
//        u16 score
//   u16 nBullets,   then each bullet, 14 bytes:
//        u16 id; u16 owner (ship id); f32 x, y; u16 seq (low 16 bits of the firing input's seq)
//   u8  nAsteroids, then each asteroid, 14 bytes:
//        u16 id; f32 x, y; i16 angle; u8 radius; u8 flags(bit0 hunter)
//   u8  nPickups,   then each pickup, 11 bytes:
//        u16 id; f32 x, y; u8 kind (0 shield, 1 rapid)
//   u8  nEvents,    then each event: u8 kind, then
//        1 fired:    u16 shooterId; f32 x, y                          (10)
//        2 hit:      u8 target(0 ship, 1 asteroid); u16 id; f32 x, y; u8 damage   (12)
//        3 exploded: u8 kind(0 ship, 1 asteroid); u16 id; f32 x, y; u8 radius      (12)
//
// ── 3  PING  client → server  (6 bytes)         ── 4  PONG  server → client (10 bytes)
//   0 u8 type = 3 | 4     1 u8 version             0 u8 type = 4   1 u8 version
//   2 u32 t   the client's clock, echoed back      2 u32 t   echoed   6 u32 tick  server tick
//
// Every decoder checks the length before it reads: a short or garbled frame is a CodecError,
// never an exception from DataView and never an out-of-range read.

import { PROTOCOL_VERSION } from "../protocol.js";
import { validateInput } from "../input.js";
import { wrapAngle } from "../sim/math.js";
import { CodecError } from "./errors.js";

const LE = true;

export const TYPE = Object.freeze({ INPUT: 1, SNAPSHOT: 2, PING: 3, PONG: 4 });
const PICKUP_CODES = { shield: 0, rapid: 1 };
const PICKUP_NAMES = ["shield", "rapid"];
const TARGET_NAMES = ["ship", "asteroid"];

export const SIZES = Object.freeze({
  input: 12,
  ping: 6,
  pong: 10,
  snapshotHeader: 11,
  you: 38,
  ship: 16,
  bullet: 14,
  asteroid: 14,
  pickup: 11,
  events: { fired: 11, hit: 13, exploded: 13 }, // including the 1-byte event kind
});

const clampInt = (v, min, max) => Math.min(max, Math.max(min, Math.round(v)));
const angleToI16 = (a) => clampInt(wrapAngle(a) * 1000, -32768, 32767);

class Writer {
  constructor(size) {
    this.buffer = new ArrayBuffer(size);
    this.view = new DataView(this.buffer);
    this.o = 0;
  }
  u8(v) {
    this.view.setUint8(this.o, v);
    this.o += 1;
  }
  i8(v) {
    this.view.setInt8(this.o, v);
    this.o += 1;
  }
  u16(v) {
    this.view.setUint16(this.o, v, LE);
    this.o += 2;
  }
  i16(v) {
    this.view.setInt16(this.o, v, LE);
    this.o += 2;
  }
  u32(v) {
    this.view.setUint32(this.o, v, LE);
    this.o += 4;
  }
  f32(v) {
    this.view.setFloat32(this.o, v, LE);
    this.o += 4;
  }
}

class Reader {
  constructor(data) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.length = bytes.byteLength;
    this.o = 0;
  }
  need(n) {
    if (this.o + n > this.length)
      throw new CodecError(`truncated frame (need ${n} more bytes at ${this.o} of ${this.length})`);
  }
  u8() {
    this.need(1);
    return this.view.getUint8(this.o++);
  }
  i8() {
    this.need(1);
    return this.view.getInt8(this.o++);
  }
  u16() {
    this.need(2);
    const v = this.view.getUint16(this.o, LE);
    this.o += 2;
    return v;
  }
  i16() {
    this.need(2);
    const v = this.view.getInt16(this.o, LE);
    this.o += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.view.getUint32(this.o, LE);
    this.o += 4;
    return v;
  }
  f32() {
    this.need(4);
    const v = this.view.getFloat32(this.o, LE);
    this.o += 4;
    return v;
  }
}

function header(reader, expectedType) {
  const type = reader.u8();
  const version = reader.u8();
  if (version !== PROTOCOL_VERSION) throw new CodecError(`unsupported binary version ${version}`);
  if (expectedType !== undefined && type !== expectedType)
    throw new CodecError(`unexpected type ${type}`);
  return type;
}

// ── encoders ─────────────────────────────────────────────────────────────────────────

function encodeInput(m) {
  const w = new Writer(SIZES.input);
  w.u8(TYPE.INPUT);
  w.u8(PROTOCOL_VERSION);
  w.u32(m.seq);
  w.u32(m.tick);
  w.u8((m.thrust ? 1 : 0) | (m.fire ? 2 : 0));
  w.i8(m.turn);
  return w;
}

function encodePing(m) {
  const w = new Writer(SIZES.ping);
  w.u8(TYPE.PING);
  w.u8(PROTOCOL_VERSION);
  w.u32(m.t >>> 0);
  return w;
}

function encodePong(m) {
  const w = new Writer(SIZES.pong);
  w.u8(TYPE.PONG);
  w.u8(PROTOCOL_VERSION);
  w.u32(m.t >>> 0);
  w.u32(m.tick);
  return w;
}

function encodeSnapshot(m) {
  const size =
    SIZES.snapshotHeader +
    (m.you ? SIZES.you : 0) +
    1 +
    m.ships.length * SIZES.ship +
    2 +
    m.bullets.length * SIZES.bullet +
    1 +
    m.asteroids.length * SIZES.asteroid +
    1 +
    m.pickups.length * SIZES.pickup +
    1 +
    m.events.reduce((n, e) => n + SIZES.events[e.type], 0);
  const w = new Writer(size);
  w.u8(TYPE.SNAPSHOT);
  w.u8(PROTOCOL_VERSION);
  w.u32(m.tick);
  w.u32(m.ack);
  w.u8(m.you ? 1 : 0);
  if (m.you) {
    const y = m.you;
    w.u16(y.id);
    w.f32(y.x);
    w.f32(y.y);
    w.f32(y.vx);
    w.f32(y.vy);
    w.f32(y.angle);
    w.u8(clampInt(y.hp, 0, 255));
    w.u8(y.thrusting ? 1 : 0);
    w.f32(y.cooldown);
    w.f32(y.rapid);
    w.f32(y.respawn);
    w.u16(clampInt(y.score, 0, 65535));
  }
  w.u8(m.ships.length);
  for (const s of m.ships) {
    w.u16(s.id);
    w.f32(s.x);
    w.f32(s.y);
    w.i16(angleToI16(s.angle));
    w.u8(clampInt(s.hp, 0, 255));
    w.u8((s.thrusting ? 1 : 0) | (s.dead ? 2 : 0) | (s.rapid ? 4 : 0));
    w.u16(clampInt(s.score, 0, 65535));
  }
  w.u16(m.bullets.length);
  for (const b of m.bullets) {
    w.u16(b.id);
    w.u16(b.owner);
    w.f32(b.x);
    w.f32(b.y);
    w.u16(b.seq & 0xffff);
  }
  w.u8(m.asteroids.length);
  for (const a of m.asteroids) {
    w.u16(a.id);
    w.f32(a.x);
    w.f32(a.y);
    w.i16(angleToI16(a.angle));
    w.u8(clampInt(a.radius, 0, 255));
    w.u8(a.hunter ? 1 : 0);
  }
  w.u8(m.pickups.length);
  for (const p of m.pickups) {
    w.u16(p.id);
    w.f32(p.x);
    w.f32(p.y);
    w.u8(PICKUP_CODES[p.kind] ?? 0);
  }
  w.u8(m.events.length);
  for (const e of m.events) {
    if (e.type === "fired") {
      w.u8(1);
      w.u16(e.shooterId);
      w.f32(e.x);
      w.f32(e.y);
    } else if (e.type === "hit") {
      w.u8(2);
      w.u8(e.target === "asteroid" ? 1 : 0);
      w.u16(e.targetId);
      w.f32(e.x);
      w.f32(e.y);
      w.u8(clampInt(e.damage, 0, 255));
    } else {
      w.u8(3);
      w.u8(e.kind === "asteroid" ? 1 : 0);
      w.u16(e.id);
      w.f32(e.x);
      w.f32(e.y);
      w.u8(clampInt(e.radius, 0, 255));
    }
  }
  return w;
}

// ── decoders ─────────────────────────────────────────────────────────────────────────

function decodeInput(r) {
  const seq = r.u32();
  const tick = r.u32();
  const flags = r.u8();
  const turn = r.i8();
  const v = validateInput({ seq, tick, thrust: (flags & 1) !== 0, turn, fire: (flags & 2) !== 0 });
  if (!v.ok) throw new CodecError(`invalid input: ${v.reason}`);
  return { type: "input", ...v.input };
}

function decodeSnapshot(r) {
  const tick = r.u32();
  const ack = r.u32();
  const flags = r.u8();
  let you = null;
  if (flags & 1) {
    you = {
      id: r.u16(),
      x: r.f32(),
      y: r.f32(),
      vx: r.f32(),
      vy: r.f32(),
      angle: r.f32(),
      hp: r.u8(),
      thrusting: (r.u8() & 1) !== 0,
      cooldown: r.f32(),
      rapid: r.f32(),
      respawn: r.f32(),
      score: r.u16(),
    };
  }
  const ships = [];
  for (let n = r.u8(); n > 0; n--) {
    const s = { id: r.u16(), x: r.f32(), y: r.f32(), angle: r.i16() / 1000, hp: r.u8() };
    const f = r.u8();
    ships.push({
      ...s,
      thrusting: (f & 1) !== 0,
      dead: (f & 2) !== 0,
      rapid: (f & 4) !== 0,
      score: r.u16(),
    });
  }
  const bullets = [];
  for (let n = r.u16(); n > 0; n--) {
    bullets.push({ id: r.u16(), owner: r.u16(), x: r.f32(), y: r.f32(), seq: r.u16() });
  }
  const asteroids = [];
  for (let n = r.u8(); n > 0; n--) {
    const a = { id: r.u16(), x: r.f32(), y: r.f32(), angle: r.i16() / 1000, radius: r.u8() };
    asteroids.push({ ...a, hunter: (r.u8() & 1) !== 0 });
  }
  const pickups = [];
  for (let n = r.u8(); n > 0; n--) {
    const p = { id: r.u16(), x: r.f32(), y: r.f32() };
    const code = r.u8();
    if (code >= PICKUP_NAMES.length) throw new CodecError(`unknown pickup kind ${code}`);
    pickups.push({ ...p, kind: PICKUP_NAMES[code] });
  }
  const events = [];
  for (let n = r.u8(); n > 0; n--) {
    const kind = r.u8();
    if (kind === 1) events.push({ type: "fired", shooterId: r.u16(), x: r.f32(), y: r.f32() });
    else if (kind === 2) {
      const target = TARGET_NAMES[r.u8()] ?? "ship";
      events.push({
        type: "hit",
        target,
        targetId: r.u16(),
        x: r.f32(),
        y: r.f32(),
        damage: r.u8(),
      });
    } else if (kind === 3) {
      const k = TARGET_NAMES[r.u8()] ?? "ship";
      events.push({
        type: "exploded",
        kind: k,
        id: r.u16(),
        x: r.f32(),
        y: r.f32(),
        radius: r.u8(),
      });
    } else throw new CodecError(`unknown event kind ${kind}`);
  }
  return { type: "snapshot", tick, ack, you, ships, bullets, asteroids, pickups, events };
}

export const binaryCodec = {
  name: "binary",
  binary: true,

  /** @returns {Uint8Array} exactly the encoded bytes */
  encode(message) {
    switch (message.type) {
      case "input":
        return new Uint8Array(encodeInput(message).buffer);
      case "snapshot":
        return new Uint8Array(encodeSnapshot(message).buffer);
      case "ping":
        return new Uint8Array(encodePing(message).buffer);
      case "pong":
        return new Uint8Array(encodePong(message).buffer);
      default:
        throw new CodecError(`cannot encode "${message.type}" as binary`);
    }
  },

  /** @param {ArrayBuffer|Uint8Array} data @throws {CodecError} on anything malformed */
  decode(data) {
    const r = new Reader(data);
    const type = header(r);
    switch (type) {
      case TYPE.INPUT:
        return decodeInput(r);
      case TYPE.SNAPSHOT:
        return decodeSnapshot(r);
      case TYPE.PING:
        return { type: "ping", t: r.u32() };
      case TYPE.PONG:
        return { type: "pong", t: r.u32(), tick: r.u32() };
      default:
        throw new CodecError(`unknown message type ${type}`);
    }
  },
};
