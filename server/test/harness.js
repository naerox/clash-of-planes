// An in-process lab for netcode. The REAL authoritative Match and the REAL client GameSession
// (prediction, reconciliation, interpolation, both codecs) run in one Node process, joined by a
// virtual network with configurable round-trip time, jitter and loss — all on a virtual clock
// advanced in 1 ms steps, so a 30-second match takes milliseconds and every run is repeatable.
//
// It is used by the tests, and by scripts/netcode-report.js to produce the numbers in the README.
//
// (It imports client code across the workspace on purpose: that is the point of the lab — the
// same shared simulation, exercised from both sides.)

import { Rng, STEP_MS, binaryCodec, getCodec } from "@dogfight/shared";
import { EventBus } from "../../client/src/events.js";
import { GameSession } from "../../client/src/game/session.js";
import { Match } from "../src/match.js";
import { RoomManager } from "../src/rooms.js";

const NO_ROCKS = { asteroids: 0, hunters: 0, asteroidSpeed: [40, 80] };

/** One direction of the virtual link: delay + jitter, in-order delivery, optional loss. */
class VirtualLink {
  constructor({ oneWayMs, jitterMs, loss, rng, clock }) {
    Object.assign(this, { oneWayMs, jitterMs, loss, rng, clock });
    this.queue = [];
    this.lastAt = 0;
    this.sent = 0;
    this.dropped = 0;
  }
  send(payload) {
    this.sent++;
    if (this.loss > 0 && this.rng.next() < this.loss) {
      this.dropped++;
      return;
    }
    const swing = this.jitterMs > 0 ? (this.rng.next() * 2 - 1) * this.jitterMs : 0;
    const at = Math.max(this.lastAt, this.clock.t + Math.max(0, this.oneWayMs + swing));
    this.lastAt = at;
    this.queue.push({ at, payload });
  }
  due() {
    const out = [];
    while (this.queue.length && this.queue[0].at <= this.clock.t)
      out.push(this.queue.shift().payload);
    return out;
  }
}

/**
 * @param {object} cfg
 * @param {number} [cfg.rttMs=100]      round-trip time added by the virtual network
 * @param {number} [cfg.jitterMs=0]     ± ms on each one-way delay
 * @param {number} [cfg.loss=0]         per-message loss probability, both directions
 * @param {"binary"|"json"} [cfg.codec]
 * @param {number} [cfg.clients=1]
 * @param {object} [cfg.arena]
 * @param {object[]|object} [cfg.options]  GameSession options (per client if an array)
 */
export function createSimulation({
  seed = 7,
  rttMs = 100,
  jitterMs = 0,
  loss = 0,
  codec = "binary",
  clients = 1,
  arena = NO_ROCKS,
  options = {},
  linkSeed = 1234,
  chaosSeed = 99,
  inputReserve = 0,
} = {}) {
  const clock = { t: 0 };
  const rng = new Rng(linkSeed);
  const rooms = new RoomManager({ idleMs: 1e12, maxPlayersPerRoom: 8 });
  const room = rooms.create({ name: "sim", arena });
  const inertTimer = () => ({ unref() {} });
  const match = new Match({
    room,
    seed,
    inputReserve,
    deps: { now: () => clock.t, setTimer: inertTimer, clearTimer() {} }, // we call match.step() ourselves
  });
  const wire = getCodec(codec);

  const peers = [];
  for (let i = 0; i < clients; i++) {
    const up = new VirtualLink({ oneWayMs: rttMs / 2, jitterMs, loss, rng, clock });
    const down = new VirtualLink({ oneWayMs: rttMs / 2, jitterMs, loss, rng, clock });
    const player = {
      id: `p${i}`,
      name: `P${i}`,
      deliver(message) {
        const data = wire.encode(message);
        down.send(data);
        return data.length;
      },
    };
    match.addPlayer(player);
    peers.push({ player, up, down });
  }
  const roster = peers.map((p) => ({
    id: p.player.id,
    name: p.player.name,
    shipId: p.player.shipId,
  }));

  const sessions = peers.map((peer, i) => {
    const bus = new EventBus();
    const events = [];
    for (const type of ["fired", "hit", "exploded"])
      bus.addEventListener(type, (e) => events.push(e.detail));
    const chaosRng = new Rng(chaosSeed + i);
    const session = new GameSession({
      joined: {
        shipId: peer.player.shipId,
        you: peer.player.id,
        players: roster,
        codec,
        tick: 0,
        seed,
      },
      sendNow: (data) => (up(peer, data), true),
      now: () => clock.t,
      bus,
      options: Array.isArray(options) ? options[i] : options,
      random: () => chaosRng.next(),
    });
    return { session, events, peer, renders: [], lastStepAt: 0, nextStepAt: 11 + i * 5 };
  });

  function up(peer, data) {
    peer.up.send(data);
  }

  const decodeUp = (data) => (wire.binary ? binaryCodec.decode(data) : wire.decode(data));

  let nextServerTick = STEP_MS;
  let nextRender = 0;
  let nextPing = 0;

  /**
   * Run `ms` of virtual time.
   * @param {(i: number, tMs: number) => object} controls the player's controls at time t
   * @param {(tMs: number) => void} [onMs] called every ms, after everything else
   */
  function run(ms, controls, { renderEveryMs = 1000 / 60, onMs } = {}) {
    const end = clock.t + ms;
    while (clock.t < end) {
      clock.t += 1;
      const t = clock.t;
      // 1. the network delivers
      for (const peer of peers) {
        for (const data of peer.up.due()) {
          const msg = decodeUp(data);
          if (msg.type === "input") match.receiveInput(peer.player, msg);
          else if (msg.type === "ping")
            peer.down.send(wire.encode({ type: "pong", t: msg.t, tick: match.tick }));
        }
      }
      sessions.forEach(({ session, peer }) => {
        for (const data of peer.down.due()) {
          session.noteFrame(data.length);
          if (wire.binary)
            session.handleBinary(
              data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
            );
          else session.handleMessage(JSON.parse(data));
        }
      });
      // 2. the server ticks
      if (t >= nextServerTick) {
        match.step();
        nextServerTick += STEP_MS;
      }
      // 3. each client takes its fixed step, sends pings, and renders
      sessions.forEach((entry, i) => {
        if (t >= entry.nextStepAt) {
          entry.session.step(controls(i, t));
          entry.lastStepAt = t;
          entry.nextStepAt += STEP_MS;
        }
      });
      if (t >= nextPing) {
        for (const { session } of sessions) session.ping();
        nextPing += 500;
      }
      if (t >= nextRender) {
        sessions.forEach((entry) => {
          const alpha = Math.min(1, (t - entry.lastStepAt) / STEP_MS);
          const scene = entry.session.render(t, alpha, renderEveryMs);
          entry.renders.push({ t, scene });
        });
        nextRender += renderEveryMs;
      }
      onMs?.(t);
    }
  }

  return { clock, match, room, sessions, peers, run, wire, roster };
}

// ── controls scripts ───────────────────────────────────────────────────────────────────

export const idle = () => ({ thrust: false, turn: 0, fire: false });
export const cruise = () => ({ thrust: true, turn: 0, fire: false });
/** Thrust, with a gentle turn that changes direction every 1.5 s: plenty of motion, no collisions. */
export const weave = (_i, t) => ({
  thrust: true,
  turn: Math.floor(t / 1500) % 2 === 0 ? 1 : -1,
  fire: false,
});
/** Same, shooting all the time. */
export const weaveAndShoot = (_i, t) => ({ ...weave(_i, t), fire: true });

export function summarize(values) {
  if (!values.length) return { n: 0, mean: 0, max: 0, p95: 0 };
  const xs = [...values].sort((a, b) => a - b);
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return { n: xs.length, mean, p95: xs[Math.floor(xs.length * 0.95)], max: xs.at(-1) };
}
