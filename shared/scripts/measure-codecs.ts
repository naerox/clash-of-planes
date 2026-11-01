// JSON vs binary, measured on a real simulated match (Lab 5, M4).
//   node scripts/measure-codecs.ts [players=4] [seconds=20]
//
// A 4-player match runs on the shared World (a belt of rocks, a hunter, everybody flying and
// shooting). Every tick we build the snapshot for player 0 and push it through BOTH codecs:
// how many bytes, and how long encode + decode take. The numbers feed the README table.

import {
  STEP,
  TICK_RATE,
  World,
  binaryCodec,
  buildSnapshot,
  jsonCodec,
  Rng,
  seq,
  tick,
  type GameMessage,
  type InputMessage,
  type SnapshotMessage,
  type Turn,
  type AnyCodec,
} from "../src/index.ts";

const players = Number(process.argv[2] ?? 4);
const seconds = Number(process.argv[3] ?? 20);

const world = new World({
  seed: 5,
  arena: { asteroids: 8, hunters: 1, asteroidSpeed: [50, 120] },
}).populate();
const ships = Array.from({ length: players }, (_, i) => world.addShip(`p${i}`));
const pilot = new Rng(11);
const snapshots: SnapshotMessage[] = [];
const inputs: InputMessage[] = [];
let counter = 0;
const turns: readonly Turn[] = [-1, 0, 1];
for (let t = 0; t < seconds * TICK_RATE; t++) {
  ships.forEach((ship, i) => {
    const input: InputMessage = {
      type: "input",
      seq: seq(++counter),
      tick: tick(t),
      thrust: pilot.chance(0.75),
      turn: turns[pilot.int(3)] ?? 0,
      fire: pilot.chance(0.45),
    };
    world.applyInput(ship, input, STEP);
    if (i === 0) inputs.push(input);
  });
  world.step(STEP);
  snapshots.push(
    buildSnapshot(world, { shipId: ships[0]?.id, ack: seq(counter), events: world.drainEvents() }),
  );
}

const utf8 = (s: string): number => new TextEncoder().encode(s).length;
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

function sizes(codec: AnyCodec, messages: GameMessage[]): number[] {
  return messages.map((m) => {
    const out = codec.encode(m);
    return typeof out === "string" ? utf8(out) : out.length;
  });
}

/** Encode then decode with whichever codec this is (a string for JSON, bytes for binary). */
function decodeAny(codec: AnyCodec, message: GameMessage | undefined): GameMessage {
  if (message === undefined) throw new RangeError("no message");
  // the `binary` flag is the discriminant: each branch sees one concrete codec type
  return codec.binary ? codec.decode(codec.encode(message)) : codec.decode(codec.encode(message));
}

function microseconds(codec: AnyCodec, messages: GameMessage[], rounds: number): number {
  let sink = 0;
  const encoded = messages.map((m) => codec.encode(m));
  const t0 = process.hrtime.bigint();
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < messages.length; i++) sink += decodeAny(codec, messages[i]).type.length;
  }
  const total = Number(process.hrtime.bigint() - t0) / 1000; // µs
  void encoded;
  void sink;
  return total / (rounds * messages.length);
}

// warm up the JIT, then measure
for (const codec of [jsonCodec, binaryCodec]) microseconds(codec, snapshots.slice(0, 100), 20);

const rows = [];
for (const codec of [jsonCodec, binaryCodec]) {
  const snapBytes = mean(sizes(codec, snapshots));
  const inputBytes = mean(sizes(codec, inputs));
  rows.push({
    codec: codec.name,
    bytesPerSnapshot: Math.round(snapBytes),
    kbPerSecDown: +((snapBytes * TICK_RATE) / 1024).toFixed(2),
    bytesPerInput: Math.round(inputBytes),
    kbPerSecUp: +((inputBytes * TICK_RATE) / 1024).toFixed(2),
    snapshotUs: +microseconds(codec, snapshots, 30).toFixed(2),
    inputUs: +microseconds(codec, inputs, 100).toFixed(2),
  });
}

const entities = (s: SnapshotMessage): number =>
  s.ships.length + (s.you ? 1 : 0) + s.bullets.length + s.asteroids.length + s.pickups.length;
console.log(
  `${players} players, ${seconds} s at ${TICK_RATE} Hz: ${snapshots.length} snapshots, mean ${mean(snapshots.map(entities)).toFixed(1)} entities each`,
);
console.table(rows);
console.log(JSON.stringify(rows));
