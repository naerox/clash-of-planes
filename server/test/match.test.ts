import test from "node:test";
import assert from "node:assert/strict";
import {
  INPUT_BURST,
  STEP,
  STEP_MS,
  Ship,
  Vector2,
  binaryCodec,
  isKind,
  jsonCodec,
  seq as toSeq,
  tick,
  type ArenaConfig,
  type InputMessage,
  type SnapshotMessage,
} from "@dogfight/shared";
import type { Logger } from "../src/logger.ts";
import { Match } from "../src/match.ts";
import { RoomManager, type Player } from "../src/rooms.ts";
import type { Schedule } from "../src/schedule.ts";

const ARENA: ArenaConfig = { asteroids: 0, hunters: 0, asteroidSpeed: [40, 80] };

interface FakeTimer {
  fn: () => void;
  ms: number;
  at: number;
  cleared: boolean;
}

/** A player that remembers every snapshot it was delivered. */
type TestPlayer = Player & { snapshots: SnapshotMessage[]; last(): SnapshotMessage };

/** A match in a room, driven by hand (`step()`), with a fake clock — no real timers at all. */
function setup({
  seed = 4,
  dropTimers = true,
  log,
}: { seed?: number; dropTimers?: boolean; log?: Logger } = {}) {
  const clock = { t: 1000 };
  const timers: FakeTimer[] = [];
  const schedule: Schedule = (fn, ms) => {
    const timer: FakeTimer = { fn, ms, at: clock.t + ms, cleared: false };
    if (dropTimers) timers.push(timer);
    return () => {
      timer.cleared = true;
    };
  };
  const rooms = new RoomManager({ idleMs: 60_000 });
  const room = rooms.create({ name: "M", arena: ARENA });
  const match = new Match({ room, seed, log, deps: { now: () => clock.t, schedule } });
  const mkPlayer = (name: string): TestPlayer => {
    const snapshots: SnapshotMessage[] = [];
    const player: TestPlayer = {
      id: name,
      name,
      codec: jsonCodec,
      shipId: null,
      snapshots,
      last() {
        const snap = snapshots.at(-1);
        assert.ok(snap, "a snapshot was delivered");
        return snap;
      },
      send: () => true,
      deliver: (s) => (snapshots.push(s), 100),
      deliverControl() {},
      kick() {},
    };
    room.players.set(player.id, player); // the room's own join() is not under test here
    match.addPlayer(player);
    return player;
  };
  /** The ship the match made for this player. */
  const shipOf = (p: Player): Ship => {
    const e = p.shipId === null ? undefined : match.world.get(p.shipId);
    assert.ok(e && isKind(e, "ship"), "the player has a ship");
    return e;
  };
  /** The timer the match armed last (and take it off the list, as the event loop would). */
  const popTimer = (): FakeTimer => {
    const timer = timers.pop();
    assert.ok(timer, "a timer is armed");
    return timer;
  };
  const lastTimer = (): FakeTimer => {
    const timer = timers.at(-1);
    assert.ok(timer, "a timer is armed");
    return timer;
  };
  return { match, room, clock, timers, mkPlayer, shipOf, popTimer, lastTimer };
}

const input = (n: number, over: Partial<Omit<InputMessage, "type">> = {}): InputMessage => ({
  type: "input",
  seq: toSeq(n),
  tick: tick(0),
  thrust: false,
  turn: 0,
  fire: false,
  ...over,
});

test("a ship is created for the player; the world is seeded and populated from the room's arena", () => {
  const { match, mkPlayer, shipOf } = setup();
  const a = mkPlayer("a");
  assert.equal(typeof a.shipId, "number");
  assert.equal(shipOf(a).kind, "ship");
  assert.equal(match.seed, 4);
  assert.equal(match.players.size, 1);
});

test("inputs are applied in order, one ship step each, and `ack` = the last seq applied", () => {
  const { match, mkPlayer, shipOf } = setup();
  const a = mkPlayer("a");
  const ship = shipOf(a);
  ship.angle = 0;
  const twin = Ship.fromState(ship.toState()); // an identical ship the test steps by hand
  const start = ship.pos.x;
  for (let seq = 1; seq <= 3; seq++) match.receiveInput(a, input(seq, { thrust: true }));
  match.step();
  assert.equal(a.last().ack, 3);
  assert.ok(ship.pos.x > start);
  for (let i = 0; i < 3; i++) twin.integrate({ thrust: true, turn: 0 }, STEP);
  assert.deepEqual(
    { x: ship.pos.x, y: ship.pos.y, vx: ship.vel.x, vy: ship.vel.y },
    { x: twin.pos.x, y: twin.pos.y, vx: twin.vel.x, vy: twin.vel.y },
    "the server applied exactly the shared integrate, three times",
  );
  match.step(); // nothing new: the ack stays
  assert.equal(a.last().ack, 3);
});

test("a ship moves only when it receives inputs (the world clock does not move ships)", () => {
  const { match, mkPlayer, shipOf } = setup();
  const a = mkPlayer("a");
  const ship = shipOf(a);
  ship.vel = ship.vel.add(new Vector2(300, 0));
  const x = ship.pos.x;
  for (let i = 0; i < 10; i++) match.step();
  assert.equal(ship.pos.x, x);
});

test("duplicate and out-of-order inputs are ignored", () => {
  const { match, mkPlayer } = setup();
  const a = mkPlayer("a");
  assert.equal(match.receiveInput(a, input(5)), true);
  assert.equal(match.receiveInput(a, input(5)), false, "duplicate");
  assert.equal(match.receiveInput(a, input(4)), false, "older than what was accepted");
  assert.equal(match.receiveInput(a, input(6)), true);
  match.step();
  assert.equal(a.last().ack, 6);
});

test("speed hack: inputs beyond the rate budget are not applied", () => {
  const { match, mkPlayer } = setup();
  const a = mkPlayer("a");
  // 200 inputs in one instant: only the burst allowance gets through
  let accepted = 0;
  for (let seq = 1; seq <= 200; seq++)
    if (match.receiveInput(a, input(seq, { thrust: true }))) accepted++;
  assert.equal(accepted, INPUT_BURST);
  assert.equal(match.stats.inputsRejected, 200 - INPUT_BURST);
  match.step();
  assert.equal(a.last().ack, INPUT_BURST);
});

test("an input flood gets the client kicked", () => {
  const { match, mkPlayer } = setup();
  const a = mkPlayer("a");
  let kicked: string | null = null;
  a.kick = (why) => (kicked = why);
  for (let seq = 1; seq <= INPUT_BURST + 400; seq++) match.receiveInput(a, input(seq));
  assert.match(String(kicked), /flood/);
});

test("firing: the bullet carries the input's seq, and the snapshot (and events) report it", () => {
  const { match, mkPlayer } = setup();
  const a = mkPlayer("a");
  match.receiveInput(a, input(7, { fire: true }));
  match.step();
  const snap = a.last();
  assert.equal(snap.bullets.length, 1);
  assert.equal(snap.bullets[0]?.seq, 7);
  assert.equal(snap.bullets[0]?.owner, a.shipId);
  assert.ok(snap.events.some((e) => e.type === "fired"));
});

test("each client gets its own snapshot: `you` is its ship, the others are in `ships`", () => {
  const { match, mkPlayer } = setup();
  const a = mkPlayer("a");
  const b = mkPlayer("b");
  match.receiveInput(a, input(1));
  match.step();
  const sa = a.last();
  const sb = b.last();
  assert.equal(sa.you?.id, a.shipId);
  assert.equal(sb.you?.id, b.shipId);
  assert.deepEqual(
    sa.ships.map((s) => s.id),
    [b.shipId],
  );
  assert.deepEqual(
    sb.ships.map((s) => s.id),
    [a.shipId],
  );
  assert.equal(sa.ack, 1);
  assert.equal(sb.ack, 0, "b sent nothing: its ack is its own");
  assert.equal(sa.tick, sb.tick);
});

test("snapshots are encodable by the binary codec (what really goes on the wire)", () => {
  const { match, mkPlayer } = setup();
  const a = mkPlayer("a");
  mkPlayer("b");
  match.receiveInput(a, input(1, { fire: true, thrust: true }));
  match.step();
  const back = binaryCodec.decode(binaryCodec.encode(a.last()));
  assert.ok(back.type === "snapshot");
  assert.equal(back.ack, 1);
  assert.equal(back.bullets.length, 1);
});

test("a player's bullet kills another player's ship and the score goes to the shooter", () => {
  const { match, clock, mkPlayer, shipOf } = setup();
  const a = mkPlayer("a");
  const b = mkPlayer("b");
  const [shipA, shipB] = [shipOf(a), shipOf(b)];
  shipA.angle = 0;
  shipB.pos = shipA.pos.add(new Vector2(70, 0));
  // a real client's pace: one input per tick, holding fire the whole time
  for (let seq = 1; seq <= 400 && !shipB.isDead; seq++) {
    clock.t += STEP_MS;
    match.receiveInput(a, input(seq, { fire: true }));
    match.step();
    shipB.pos = shipA.pos.add(new Vector2(70, 0)); // b is a sitting duck (it sends no inputs)
  }
  assert.equal(shipB.isDead, true);
  assert.equal(shipA.score, 1);
  assert.ok((b.last().you?.respawn ?? 0) > 0, "b learns it is dead and when it will return");
  assert.ok(
    a.snapshots.some((s) => s.events.some((e) => e.type === "exploded" && e.kind === "ship")),
  );
});

test("a leaving player's ship is removed; the match stops with the last player", () => {
  const { match, mkPlayer, lastTimer } = setup();
  const a = mkPlayer("a");
  const b = mkPlayer("b");
  const shipId = a.shipId;
  assert.ok(shipId !== null);
  match.removePlayer(a);
  match.step();
  assert.equal(match.world.get(shipId), undefined);
  assert.equal(match.running, true);
  match.removePlayer(b);
  assert.equal(match.running, false);
  assert.ok(lastTimer().cleared);
});

test("world events go to the room's match log", () => {
  const { match, room, mkPlayer } = setup();
  const a = mkPlayer("a");
  const logged: string[] = [];
  room.on("event", (e) => logged.push(e.type));
  match.receiveInput(a, input(1, { fire: true }));
  match.step();
  assert.ok(logged.includes("fired"));
});

// ── the clock ────────────────────────────────────────────────────────────────────────

test("the first tick is scheduled one step ahead", () => {
  const { match, timers, mkPlayer } = setup();
  mkPlayer("a");
  assert.equal(timers.length, 1);
  assert.ok(Math.abs((timers[0]?.ms ?? NaN) - STEP_MS) < 1e-9);
  assert.ok(match.running);
});

test("absolute-target timing: a late tick shortens the NEXT wait instead of shifting everything", () => {
  const { match, clock, mkPlayer, popTimer, lastTimer } = setup();
  mkPlayer("a");
  const t0 = clock.t;
  // the OS wakes us 5 ms late
  clock.t = t0 + STEP_MS + 5;
  popTimer().fn();
  const next = lastTimer();
  // the second tick is still aimed at t0 + 2×STEP_MS, so only (STEP_MS − 5) from now
  assert.ok(Math.abs(next.ms - (STEP_MS - 5)) < 1e-9, `next wait ${next.ms}`);
  assert.ok(Math.abs(next.at - (t0 + 2 * STEP_MS)) < 1e-9);
  assert.equal(match.stats.lateness.summary().max, 5);
});

test("no drift: 300 ticks, each handled 4 ms late, still end at exactly 300 × STEP_MS", () => {
  const { match, clock, mkPlayer, popTimer, lastTimer } = setup();
  mkPlayer("a");
  const t0 = clock.t;
  for (let i = 0; i < 300; i++) {
    const timer = popTimer();
    clock.t = timer.at + 4; // always 4 ms late
    timer.fn();
  }
  assert.equal(match.tick, 300);
  assert.ok(Math.abs(lastTimer().at - (t0 + 301 * STEP_MS)) < 1e-6, "the schedule never slipped");
  // what a naive `setInterval`-style chain (re-arm relative to when the callback ran) does:
  const naive = t0 + 300 * (STEP_MS + 4);
  assert.ok(naive - (t0 + 300 * STEP_MS) > 1100, "…would have drifted over a second in 10 s");
});

test("a tick that overruns is counted, and the next ones run immediately to catch up", () => {
  const { match, clock, mkPlayer, popTimer, lastTimer } = setup();
  mkPlayer("a");
  const t0 = clock.t;
  const slow = popTimer();
  clock.t = slow.at;
  const realStep = match.step.bind(match);
  match.step = () => {
    realStep();
    clock.t += 80; // this tick takes 80 ms: 2.4 intervals
  };
  slow.fn();
  assert.equal(match.stats.overruns, 1);
  assert.equal(lastTimer().ms, 0, "behind schedule: the next tick is not delayed");
  assert.ok(lastTimer().at <= clock.t);
  assert.ok(clock.t - t0 > STEP_MS * 2);
});

test("far behind (CPU-bound): ticks are skipped, not raced through", () => {
  const { match, clock, mkPlayer, popTimer, lastTimer } = setup();
  mkPlayer("a");
  const timer = popTimer();
  clock.t = timer.at;
  const realStep = match.step.bind(match);
  match.step = () => {
    realStep();
    clock.t += 1000; // a one-second stall
  };
  timer.fn();
  assert.ok(match.stats.skipped >= 25);
  assert.ok(Math.abs(lastTimer().ms - STEP_MS) < 1e-9, "the schedule restarts from now");
});

test("an error inside a tick is logged, and the clock keeps running", () => {
  const errors: string[] = [];
  const log: Logger = { info() {}, warn() {}, error: (m) => void errors.push(m) };
  const { match, timers, clock, mkPlayer, popTimer } = setup({ log });
  mkPlayer("a");
  match.step = () => {
    throw new Error("boom");
  };
  const timer = popTimer();
  clock.t = timer.at;
  timer.fn();
  assert.deepEqual(errors, ["tick failed"]);
  assert.equal(timers.length, 1, "the next tick is scheduled regardless");
});

test("summary(): what /api/stats publishes", () => {
  const { match, clock, mkPlayer, popTimer } = setup();
  const a = mkPlayer("a");
  for (let i = 0; i < 20; i++) {
    const timer = popTimer();
    clock.t = timer.at + 1;
    match.receiveInput(a, input(i + 1));
    timer.fn();
  }
  const s = match.summary();
  assert.equal(s.tick, 20);
  assert.equal(s.players, 1);
  assert.equal(s.tickLatenessMs.n, 20);
  assert.ok(s.tickLatenessMs.max >= 1);
  assert.equal(s.inputsApplied, 20);
  assert.ok(s.bytesOutPerSec > 0);
  assert.ok(s.tickDurationMs.mean >= 0);
});
