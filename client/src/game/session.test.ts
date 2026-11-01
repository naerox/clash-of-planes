import test from "node:test";
import assert from "node:assert/strict";
import {
  Vector2,
  World,
  binaryCodec,
  buildSnapshot,
  entityId,
  getCodec,
  parseServerMessage,
  seq,
  STEP_MS,
  tick,
  type CodecName,
  type SimEvent,
  type SnapshotMessage,
} from "@dogfight/shared";
import { Bus, type GameEvents } from "../events.ts";
import type { PlayerControls } from "../input.ts";
import { joinedMsg } from "../testing.ts";
import { GameSession, type SessionOptions } from "./session.ts";

/** A server-side world with one player, and a session wired to it by hand. */
function setup({
  codec = "binary",
  options = {},
}: { codec?: CodecName; options?: Partial<SessionOptions> } = {}) {
  const world = new World({ seed: 3 });
  const ship = world.addShip("me");
  const clock = { t: 1000 };
  const sent: (string | Uint8Array)[] = [];
  const bus = new Bus<GameEvents>();
  const events: SimEvent[] = [];
  bus.on("fired", (e) => events.push(e));
  bus.on("hit", (e) => events.push(e));
  bus.on("exploded", (e) => events.push(e));
  const session = new GameSession({
    joined: joinedMsg({
      shipId: ship.id,
      you: "me",
      players: [{ id: "me", name: "Ace", shipId: ship.id }],
      codec,
      seed: 3,
    }),
    sendNow: (data) => (sent.push(data), true),
    now: () => clock.t,
    bus,
    options,
  });
  const wire = getCodec(codec);
  /** Builds the next snapshot on the "server" and hands it to the session as a frame. */
  const deliver = (ack = 0, extra: Partial<SnapshotMessage> = {}): SnapshotMessage => {
    world.step(1 / 30);
    const snap: SnapshotMessage = {
      ...buildSnapshot(world, { shipId: ship.id, ack: seq(ack), events: world.drainEvents() }),
      ...extra,
    };
    clock.t += STEP_MS;
    send(snap);
    return snap;
  };
  /** Puts a snapshot on the wire in the session's codec and feeds the session the frame. */
  const send = (snap: SnapshotMessage): void => {
    if (wire.binary) {
      const bytes = wire.encode(snap);
      session.noteFrame(bytes.length);
      session.handleBinary(new Uint8Array(bytes).buffer);
    } else {
      const text = wire.encode(snap);
      session.noteFrame(text.length);
      const parsed = parseServerMessage(text);
      assert.ok(parsed.ok, "the JSON frame must parse");
      session.handleMessage(parsed.msg);
    }
  };
  return { world, ship, clock, sent, session, events, deliver, send };
}
const controls: PlayerControls = { thrust: true, turn: 0, fire: false };

test("step numbers the inputs 1, 2, 3 … and sends each in the session's codec", () => {
  const { session, sent } = setup();
  session.step(controls);
  session.step(controls);
  const decoded = sent.map((d) => (typeof d === "string" ? null : binaryCodec.decode(d)));
  assert.deepEqual(
    decoded.map((m) => (m?.type === "input" ? m.seq : null)),
    [1, 2],
  );
  const first = decoded[0];
  assert.ok(first?.type === "input");
  assert.equal(first.thrust, true);
  assert.equal(sent[0]?.length, 12);
});

test("the JSON codec sends text", () => {
  const { session, sent } = setup({ codec: "json" });
  session.step(controls);
  const first = sent[0];
  assert.equal(typeof first, "string");
  assert.ok(typeof first === "string" && first.includes('"type":"input"'));
});

test("before the first snapshot there is nothing to predict with; after it, the ship moves at once", () => {
  const { session, deliver } = setup();
  session.step(controls);
  assert.equal(session.predictor, null);
  assert.equal(session.render(1000, 0).me, null);
  deliver();
  assert.ok(session.predictor);
  const before = session.render(1100, 1).me;
  session.step(controls);
  const after = session.render(1100, 1).me;
  assert.ok(before && after);
  assert.ok(after.x !== before.x || after.y !== before.y, "the ship answered the same step");
});

test("an acknowledged snapshot trims `pending` and reports a correction", () => {
  const { session, deliver } = setup();
  deliver(); // first state
  for (let i = 0; i < 5; i++) session.step(controls);
  assert.equal(session.predictor?.pending.length, 5);
  deliver(3);
  assert.equal(session.predictor?.pending.length, 2);
  assert.equal(session.stats.corrections.values.length, 1);
});

test("prediction OFF (the 'dumb client'): the ship is exactly where the newest snapshot says", () => {
  const { session, ship, deliver } = setup({ options: { predict: false } });
  deliver();
  session.step(controls);
  ship.pos = ship.pos.add(new Vector2(40, 0));
  deliver();
  const me = session.render(2000, 0.5).me;
  assert.equal(session.predictor, null);
  assert.ok(me);
  assert.ok(Math.abs(me.x - ship.pos.x) < 0.01);
});

test("toggling prediction re-syncs from the next snapshot", () => {
  const { session, deliver } = setup();
  deliver();
  session.setOptions({ predict: false });
  assert.equal(session.predictor, null);
  session.setOptions({ predict: true });
  deliver();
  assert.ok(session.predictor);
});

test("events in a snapshot reach the bus once; our own 'fired' echo is skipped while predicting", () => {
  const { session, ship, world, deliver, events } = setup();
  deliver();
  ship.fire(world, seq(1)); // the server-side shot
  world.emit({ type: "hit", target: "asteroid", targetId: entityId(9), x: 1, y: 2, damage: 12 });
  deliver(1);
  assert.deepEqual(
    events.map((e) => e.type),
    ["hit"],
    "the 'fired' of our own ship is not repeated",
  );
  const other = world.addShip("other");
  other.fire(world, seq(1));
  deliver(1);
  assert.equal(events.filter((e) => e.type === "fired").length, 1, "…but another player's shot is");
  void session;
});

test("with prediction off, our own 'fired' DOES come from the server", () => {
  const { ship, world, deliver, events } = setup({ options: { predict: false } });
  deliver();
  ship.fire(world, seq(1));
  deliver(1);
  assert.equal(events.filter((e) => e.type === "fired").length, 1);
});

test("a predicted shot is announced when it is fired", () => {
  const { session, deliver, events } = setup();
  deliver();
  session.step({ thrust: false, turn: 0, fire: true });
  assert.deepEqual(
    events.map((e) => e.type),
    ["fired"],
  );
});

test("a respawn (the server moving our ship far away) is counted apart, not as a prediction error", () => {
  const { session, ship, deliver } = setup();
  deliver();
  deliver();
  const errors = session.stats.corrections.values.length;
  ship.pos = ship.pos.add(new Vector2(600, 300));
  deliver();
  assert.equal(session.stats.corrections.values.length, errors, "not in the correction record");
  assert.equal(session.stats.report().teleports, 1);
  assert.ok(
    session.stats.report().correctionMax < 1,
    "the netgraph's max is not drowned by one death",
  );
});

test("late and duplicate snapshots are ignored and do not disturb the prediction", () => {
  const { session, deliver, send } = setup();
  const first = deliver();
  deliver();
  const corrections = session.stats.corrections.values.length;
  send(first); // the first one again, late
  assert.equal(session.stats.corrections.values.length, corrections);
  assert.equal(session.buffer.discarded, 1);
});

test("garbage frames are counted, not thrown", () => {
  const { session } = setup();
  assert.doesNotThrow(() => session.handleBinary(new Uint8Array([2, 1, 0]).buffer));
  assert.doesNotThrow(() => session.handleBinary(new Uint8Array([9, 9, 9, 9]).buffer));
  assert.equal(session.stats.badFrames, 2);
});

test("pong → RTT", () => {
  const { session, clock } = setup();
  clock.t = 5000;
  session.handleBinary(
    new Uint8Array(binaryCodec.encode({ type: "pong", t: 4860, tick: tick(12) })).buffer,
  );
  assert.equal(session.stats.report().rttMs, 140);
});

test("ping sends the client clock in the session's codec", () => {
  const { session, clock, sent } = setup();
  clock.t = 2500.7;
  session.ping();
  const first = sent[0];
  assert.ok(first && typeof first !== "string");
  assert.deepEqual(binaryCodec.decode(first), { type: "ping", t: 2500 });
});

test("render(): other players are interpolated with names, our bullets come from prediction", () => {
  const { session, world, deliver } = setup();
  const other = world.addShip("other");
  deliver();
  session.setPlayers([{ id: "other", name: "Bob", shipId: other.id }]);
  for (let i = 0; i < 6; i++) deliver();
  const scene = session.render(1000 + 6 * STEP_MS, 0.5);
  const bob = scene.ships.find((s) => s.id === other.id);
  assert.ok(bob);
  assert.equal(bob.name, "Bob");
  assert.equal(bob.isMe, false);
  assert.ok(scene.ships.some((s) => s.isMe));
  assert.equal(scene.me?.isMe, true);
});

test("rejoin starts over with the new ship but keeps counting inputs", () => {
  const { session, deliver } = setup();
  deliver();
  session.step(controls);
  session.step(controls);
  session.rejoin(joinedMsg({ shipId: entityId(77), you: "x", players: [] }));
  assert.equal(session.predictor, null);
  assert.equal(session.shipId, 77);
  assert.equal(session.step(controls).seq, 3);
});

test("debug(): everything the measurement scripts and the netgraph read", () => {
  const { session, deliver } = setup();
  deliver();
  session.step(controls);
  const d = session.debug();
  assert.equal(d.codec, "binary");
  assert.equal(d.seq, 1);
  assert.equal(d.pending, 1);
  assert.ok(d.predicted && d.server);
  assert.equal(d.options.interpMs, 100);
});
