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

import { entityId, seq, shotSeq, tick, type EntityId, type Seq, type Tick } from "../brand.ts";
import type { Turn } from "../input.ts";
import {
  PROTOCOL_VERSION,
  type AsteroidSnap,
  type BulletSnap,
  type GameMessage,
  type InputMessage,
  type PickupSnap,
  type PongMessage,
  type ShipSnap,
  type SnapshotMessage,
} from "../protocol.ts";
import { wrapAngle } from "../sim/math.ts";
import type { SimEvent } from "../sim/events.ts";
import type { PickupType } from "../sim/pickup.ts";
import type { ShipState } from "../sim/ship.ts";
import type { BinaryCodec } from "./codec.ts";
import { CodecError } from "./errors.ts";

const LE = true;

export const TYPE = Object.freeze({ INPUT: 1, SNAPSHOT: 2, PING: 3, PONG: 4 });
const PICKUP_CODES: Record<PickupType, number> = { shield: 0, rapid: 1 };
const PICKUP_NAMES: readonly PickupType[] = ["shield", "rapid"];
const TARGET_NAMES = ["ship", "asteroid"] as const;

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

const clampInt = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(v)));
const angleToI16 = (a: number): number => clampInt(wrapAngle(a) * 1000, -32768, 32767);

class Writer {
  readonly buffer: ArrayBuffer;
  readonly view: DataView;
  o = 0;

  constructor(size: number) {
    this.buffer = new ArrayBuffer(size);
    this.view = new DataView(this.buffer);
  }
  u8(v: number): void {
    this.view.setUint8(this.o, v);
    this.o += 1;
  }
  i8(v: number): void {
    this.view.setInt8(this.o, v);
    this.o += 1;
  }
  u16(v: number): void {
    this.view.setUint16(this.o, v, LE);
    this.o += 2;
  }
  i16(v: number): void {
    this.view.setInt16(this.o, v, LE);
    this.o += 2;
  }
  u32(v: number): void {
    this.view.setUint32(this.o, v, LE);
    this.o += 4;
  }
  f32(v: number): void {
    this.view.setFloat32(this.o, v, LE);
    this.o += 4;
  }
}

/**
 * Reads bytes and refuses everything that is not a valid message: every read checks that the
 * bytes exist, every float is checked to be finite, and `end()` rejects trailing garbage.
 * What comes out is already typed (branded ids, ticks, seqs) — no further validation is needed.
 */
class Reader {
  readonly view: DataView;
  readonly length: number;
  o = 0;

  constructor(data: ArrayBuffer | Uint8Array) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.length = bytes.byteLength;
  }
  need(n: number): void {
    if (this.o + n > this.length)
      throw new CodecError(`truncated frame (need ${n} more bytes at ${this.o} of ${this.length})`);
  }
  end(): void {
    if (this.o !== this.length)
      throw new CodecError(`${this.length - this.o} unexpected trailing bytes`);
  }
  u8(): number {
    this.need(1);
    return this.view.getUint8(this.o++);
  }
  i8(): number {
    this.need(1);
    return this.view.getInt8(this.o++);
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.o, LE);
    this.o += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.o, LE);
    this.o += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.o, LE);
    this.o += 4;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.o, LE);
    this.o += 4;
    if (!Number.isFinite(v)) throw new CodecError("non-finite float");
    return v;
  }
  id(): EntityId {
    return entityId(this.u16());
  }
  tick(): Tick {
    return tick(this.u32());
  }
  seq(): Seq {
    return seq(this.u32());
  }
  bool(flags: number, bit: number): boolean {
    return (flags & bit) !== 0;
  }
}

function header(reader: Reader): number {
  const type = reader.u8();
  const version = reader.u8();
  if (version !== PROTOCOL_VERSION) throw new CodecError(`unsupported binary version ${version}`);
  return type;
}

// ── encoders ─────────────────────────────────────────────────────────────────────────

function encodeInput(m: InputMessage): Writer {
  const w = new Writer(SIZES.input);
  w.u8(TYPE.INPUT);
  w.u8(PROTOCOL_VERSION);
  w.u32(m.seq);
  w.u32(m.tick);
  w.u8((m.thrust ? 1 : 0) | (m.fire ? 2 : 0));
  w.i8(m.turn);
  return w;
}

function encodePing(m: { t: number }): Writer {
  const w = new Writer(SIZES.ping);
  w.u8(TYPE.PING);
  w.u8(PROTOCOL_VERSION);
  w.u32(m.t >>> 0);
  return w;
}

function encodePong(m: PongMessage): Writer {
  const w = new Writer(SIZES.pong);
  w.u8(TYPE.PONG);
  w.u8(PROTOCOL_VERSION);
  w.u32(m.t >>> 0);
  w.u32(m.tick);
  return w;
}

function eventSize(e: SimEvent): number {
  return SIZES.events[e.type];
}

function writeEvent(w: Writer, e: SimEvent): void {
  switch (e.type) {
    case "fired":
      w.u8(1);
      w.u16(e.shooterId);
      w.f32(e.x);
      w.f32(e.y);
      break;
    case "hit":
      w.u8(2);
      w.u8(e.target === "asteroid" ? 1 : 0);
      w.u16(e.targetId);
      w.f32(e.x);
      w.f32(e.y);
      w.u8(clampInt(e.damage, 0, 255));
      break;
    case "exploded":
      w.u8(3);
      w.u8(e.kind === "asteroid" ? 1 : 0);
      w.u16(e.id);
      w.f32(e.x);
      w.f32(e.y);
      w.u8(clampInt(e.radius, 0, 255));
      break;
    default: {
      const unreachable: never = e;
      throw new CodecError(`cannot encode event ${JSON.stringify(unreachable)}`);
    }
  }
}

function encodeSnapshot(m: SnapshotMessage): Writer {
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
    m.events.reduce((n, e) => n + eventSize(e), 0);
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
    w.u16(b.seq);
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
    w.u8(PICKUP_CODES[p.variant]);
  }
  w.u8(m.events.length);
  for (const e of m.events) writeEvent(w, e);
  return w;
}

// ── decoders ─────────────────────────────────────────────────────────────────────────

function decodeInput(r: Reader): InputMessage {
  const seqNo = r.u32();
  const tickNo = r.u32();
  const flags = r.u8();
  const turn = r.i8();
  r.end();
  if (seqNo < 1) throw new CodecError("invalid input: seq must be at least 1");
  if (flags > 3) throw new CodecError("invalid input: unknown flag bits");
  return {
    type: "input",
    seq: seq(seqNo),
    tick: tick(tickNo),
    thrust: r.bool(flags, 1),
    fire: r.bool(flags, 2),
    turn: toTurn(turn),
  };
}

function toTurn(n: number): Turn {
  if (n === -1 || n === 0 || n === 1) return n;
  throw new CodecError("invalid input: turn must be -1, 0 or 1");
}

function targetName(code: number): (typeof TARGET_NAMES)[number] {
  const name = TARGET_NAMES[code];
  if (name === undefined) throw new CodecError(`unknown target ${code}`);
  return name;
}

function pickupName(code: number): PickupType {
  const name = PICKUP_NAMES[code];
  if (name === undefined) throw new CodecError(`unknown pickup kind ${code}`);
  return name;
}

function readYou(r: Reader): ShipState {
  return {
    id: r.id(),
    x: r.f32(),
    y: r.f32(),
    vx: r.f32(),
    vy: r.f32(),
    angle: r.f32(),
    hp: r.u8(),
    thrusting: r.bool(r.u8(), 1),
    cooldown: r.f32(),
    rapid: r.f32(),
    respawn: r.f32(),
    score: r.u16(),
  };
}

function readShip(r: Reader): ShipSnap {
  const id = r.id();
  const x = r.f32();
  const y = r.f32();
  const angle = r.i16() / 1000;
  const hp = r.u8();
  const f = r.u8();
  return {
    kind: "ship",
    id,
    x,
    y,
    angle,
    hp,
    thrusting: r.bool(f, 1),
    dead: r.bool(f, 2),
    rapid: r.bool(f, 4),
    score: r.u16(),
  };
}

function readBullet(r: Reader): BulletSnap {
  return {
    kind: "bullet",
    id: r.id(),
    owner: r.id(),
    x: r.f32(),
    y: r.f32(),
    seq: shotSeq(r.u16()),
  };
}

function readAsteroid(r: Reader): AsteroidSnap {
  const id = r.id();
  const x = r.f32();
  const y = r.f32();
  const angle = r.i16() / 1000;
  const radius = r.u8();
  return { kind: "asteroid", id, x, y, angle, radius, hunter: r.bool(r.u8(), 1) };
}

function readPickup(r: Reader): PickupSnap {
  const id = r.id();
  const x = r.f32();
  const y = r.f32();
  return { kind: "pickup", id, x, y, variant: pickupName(r.u8()) };
}

function readEvent(r: Reader): SimEvent {
  const kind = r.u8(); // a wire number, not a typed value: the `default` below is a real error path
  switch (kind) {
    case 1:
      return { type: "fired", shooterId: r.id(), x: r.f32(), y: r.f32() };
    case 2: {
      const target = targetName(r.u8());
      return {
        type: "hit",
        target,
        targetId: r.id(),
        x: r.f32(),
        y: r.f32(),
        damage: r.u8(),
      };
    }
    case 3: {
      const k = targetName(r.u8());
      return { type: "exploded", kind: k, id: r.id(), x: r.f32(), y: r.f32(), radius: r.u8() };
    }
    default:
      throw new CodecError(`unknown event kind ${kind}`);
  }
}

function readList<T>(count: number, read: () => T): T[] {
  const out: T[] = [];
  for (let n = count; n > 0; n--) out.push(read());
  return out;
}

function decodeSnapshot(r: Reader): SnapshotMessage {
  const tickNo = r.tick();
  const ack = r.seq();
  const flags = r.u8();
  const you = r.bool(flags, 1) ? readYou(r) : null;
  const ships = readList(r.u8(), () => readShip(r));
  const bullets = readList(r.u16(), () => readBullet(r));
  const asteroids = readList(r.u8(), () => readAsteroid(r));
  const pickups = readList(r.u8(), () => readPickup(r));
  const events = readList(r.u8(), () => readEvent(r));
  r.end();
  return { type: "snapshot", tick: tickNo, ack, you, ships, bullets, asteroids, pickups, events };
}

export const binaryCodec: BinaryCodec = {
  name: "binary",
  binary: true,

  /** Exactly the encoded bytes. */
  encode(message: GameMessage): Uint8Array {
    switch (message.type) {
      case "input":
        return new Uint8Array(encodeInput(message).buffer);
      case "snapshot":
        return new Uint8Array(encodeSnapshot(message).buffer);
      case "ping":
        return new Uint8Array(encodePing(message).buffer);
      case "pong":
        return new Uint8Array(encodePong(message).buffer);
      default: {
        const unreachable: never = message;
        throw new CodecError(`cannot encode ${JSON.stringify(unreachable)} as binary`);
      }
    }
  },

  /** @throws {CodecError} on anything malformed: short, long, wrong version, out of range */
  decode(data: ArrayBuffer | Uint8Array): GameMessage {
    const r = new Reader(data);
    const type = header(r);
    switch (type) {
      case TYPE.INPUT:
        return decodeInput(r);
      case TYPE.SNAPSHOT:
        return decodeSnapshot(r);
      case TYPE.PING: {
        const t = r.u32();
        r.end();
        return { type: "ping", t };
      }
      case TYPE.PONG: {
        const t = r.u32();
        const tickNo = r.tick();
        r.end();
        return { type: "pong", t, tick: tickNo };
      }
      default:
        throw new CodecError(`unknown message type ${type}`);
    }
  },
};
