// An in-process lab for netcode. The REAL authoritative Match and the REAL client GameSession
// (prediction, reconciliation, interpolation, both codecs) run in one Node process, joined by a
// virtual network with configurable round-trip time, jitter and loss — all on a virtual clock
// advanced in 1 ms steps, so a 30-second match takes milliseconds and every run is repeatable.
//
// It is used by the tests, and by scripts/netcode-report.ts to produce the numbers in the README.
//
// (It imports client code across the workspace on purpose: that is the point of the lab — the
// same shared simulation, exercised from both sides.)

import {
  Rng,
  STEP_MS,
  binaryCodec,
  Ship,
  getCodec,
  isKind,
  jsonCodec,
  parseServerMessage,
  tick,
  type AnyCodec,
  type ArenaConfig,
  type CodecName,
  type GameMessage,
  type RosterEntry,
  type SimEvent,
} from "@dogfight/shared";
import type { Scene } from "../../client/src/game/scene.ts";
import { Bus, type GameEvents } from "../../client/src/events.ts";
import type { PlayerControls } from "../../client/src/input.ts";
import { GameSession, type SessionOptions } from "../../client/src/game/session.ts";
import { Match } from "../src/match.ts";
import { RoomManager, type Player } from "../src/rooms.ts";
import type { Schedule } from "../src/schedule.ts";

const NO_ROCKS: ArenaConfig = { asteroids: 0, hunters: 0, asteroidSpeed: [40, 80] };

/** A frame on the virtual wire: text for the JSON codec, bytes for the binary one. */
type Wire = string | Uint8Array;

interface Clock {
  t: number;
}

interface Peer {
  readonly player: Player;
  readonly up: VirtualLink;
  readonly down: VirtualLink;
}

/** One direction of the virtual link: delay + jitter, in-order delivery, optional loss. */
interface LinkConfig {
  oneWayMs: number;
  jitterMs: number;
  loss: number;
  rng: Rng;
  clock: Clock;
}

class VirtualLink {
  readonly oneWayMs: number;
  readonly jitterMs: number;
  readonly loss: number;
  readonly rng: Rng;
  readonly clock: Clock;
  readonly queue: { at: number; payload: Wire }[] = [];
  lastAt = 0;
  sent = 0;
  dropped = 0;

  constructor({ oneWayMs, jitterMs, loss, rng, clock }: LinkConfig) {
    this.oneWayMs = oneWayMs;
    this.jitterMs = jitterMs;
    this.loss = loss;
    this.rng = rng;
    this.clock = clock;
  }
  send(payload: Wire): void {
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
  due(): Wire[] {
    const out: Wire[] = [];
    for (;;) {
      const head = this.queue[0];
      if (!head || head.at > this.clock.t) return out;
      this.queue.shift();
      out.push(head.payload);
    }
  }
}

export interface SimulationConfig {
  seed?: number;
  /** Round-trip time added by the virtual network. */
  rttMs?: number;
  /** ± ms on each one-way delay. */
  jitterMs?: number;
  /** Per-message loss probability, both directions. */
  loss?: number;
  codec?: CodecName;
  clients?: number;
  arena?: ArenaConfig;
  /** GameSession options (per client if an array). */
  options?: Partial<SessionOptions> | Partial<SessionOptions>[];
  linkSeed?: number;
  chaosSeed?: number;
  inputReserve?: number;
}

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
}: SimulationConfig = {}) {
  const clock: Clock = { t: 0 };
  const rng = new Rng(linkSeed);
  const rooms = new RoomManager({ idleMs: 2 ** 31 - 1, maxPlayersPerRoom: 8 });
  const room = rooms.create({ name: "sim", arena });
  const inertSchedule: Schedule = () => () => {};
  const match = new Match({
    room,
    seed,
    inputReserve,
    deps: { now: () => clock.t, schedule: inertSchedule }, // we call match.step() ourselves
  });
  const wire: AnyCodec = getCodec(codec);

  const peers: Peer[] = [];
  for (let i = 0; i < clients; i++) {
    const up = new VirtualLink({ oneWayMs: rttMs / 2, jitterMs, loss, rng, clock });
    const down = new VirtualLink({ oneWayMs: rttMs / 2, jitterMs, loss, rng, clock });
    const player: Player = {
      id: `p${i}`,
      name: `P${i}`,
      codec: wire,
      shipId: null,
      send: () => true,
      deliver(snapshot) {
        const data = wire.encode(snapshot);
        down.send(data);
        return data.length;
      },
      deliverControl(message) {
        down.send(wire.encode(message));
      },
      kick() {},
    };
    match.addPlayer(player);
    peers.push({ player, up, down });
  }
  const roster: RosterEntry[] = peers.map((p) => ({
    id: p.player.id,
    name: p.player.name,
    shipId: p.player.shipId,
  }));

  const sessions = peers.map((peer, i) => {
    const bus = new Bus<GameEvents>();
    const events: SimEvent[] = [];
    bus.on("fired", (e) => events.push(e));
    bus.on("hit", (e) => events.push(e));
    bus.on("exploded", (e) => events.push(e));
    const chaosRng = new Rng(chaosSeed + i);
    const session = new GameSession({
      joined: {
        type: "joined",
        room: room.info(),
        shipId: peer.player.shipId,
        you: peer.player.id,
        players: roster,
        codec,
        tick: tick(0),
        tickRate: 30,
        seed,
      },
      sendNow: (data) => (peer.up.send(data), true),
      now: () => clock.t,
      bus,
      options: Array.isArray(options) ? options[i] : options,
      random: () => chaosRng.next(),
    });
    const renders: { t: number; scene: Scene }[] = [];
    return {
      session,
      events,
      peer,
      renders,
      lastStepAt: 0,
      nextStepAt: 11 + i * 5,
    };
  });

  const jsonDecode = (text: string): GameMessage => jsonCodec.decode(text);
  const binaryDecode = (bytes: Uint8Array): GameMessage => binaryCodec.decode(bytes);

  /** What the server makes of a frame from a client: decoded by the codec, which checks it. */
  const decodeUp = (data: Wire): GameMessage | null => {
    try {
      if (typeof data === "string") return jsonDecode(data);
      return binaryDecode(data);
    } catch {
      return null;
    }
  };

  let nextServerTick = STEP_MS;
  let nextRender = 0;
  let nextPing = 0;

  /**
   * Run `ms` of virtual time. `controls(i, t)` is player i's controls at time t; `onMs` is
   * called every ms, after everything else.
   */
  function run(
    ms: number,
    controls: (i: number, tMs: number) => PlayerControls,
    {
      renderEveryMs = 1000 / 60,
      onMs,
    }: { renderEveryMs?: number; onMs?: (tMs: number) => void } = {},
  ): void {
    const end = clock.t + ms;
    while (clock.t < end) {
      clock.t += 1;
      const t = clock.t;
      // 1. the network delivers
      for (const peer of peers) {
        for (const data of peer.up.due()) {
          const msg = decodeUp(data);
          if (msg?.type === "input") match.receiveInput(peer.player, msg);
          else if (msg?.type === "ping")
            peer.down.send(wire.encode({ type: "pong", t: msg.t, tick: match.tick }));
        }
      }
      sessions.forEach(({ session, peer }) => {
        for (const data of peer.down.due()) {
          session.noteFrame(data.length);
          if (typeof data === "string") {
            const parsed = parseServerMessage(data);
            if (parsed.ok) session.handleMessage(parsed.msg);
          } else {
            session.handleBinary(new Uint8Array(data).buffer);
          }
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

  /** Client `i`'s side of the simulation. */
  const client = (i = 0) => {
    const entry = sessions[i];
    if (!entry) throw new RangeError(`no client ${i}`);
    return entry;
  };
  /** The server's authoritative ship for client `i`. */
  const serverShip = (i = 0): Ship => {
    const id = client(i).peer.player.shipId;
    const e = id === null ? undefined : match.world.get(id);
    if (!e || !isKind(e, "ship")) throw new Error(`client ${i} has no ship on the server`);
    return e;
  };

  return { clock, match, room, sessions, peers, run, wire, roster, client, serverShip };
}

export interface Summary {
  readonly n: number;
  readonly mean: number;
  readonly max: number;
  readonly p95: number;
}

export type Simulation = ReturnType<typeof createSimulation>;

// ── controls scripts ───────────────────────────────────────────────────────────────────

export const idle = (): PlayerControls => ({ thrust: false, turn: 0, fire: false });
export const cruise = (): PlayerControls => ({ thrust: true, turn: 0, fire: false });
/** Thrust, with a gentle turn that changes direction every 1.5 s: plenty of motion, no collisions. */
export const weave = (_i: number, t: number): PlayerControls => ({
  thrust: true,
  turn: Math.floor(t / 1500) % 2 === 0 ? 1 : -1,
  fire: false,
});
/** Same, shooting all the time. */
export const weaveAndShoot = (_i: number, t: number): PlayerControls => ({
  ...weave(_i, t),
  fire: true,
});

export function summarize(values: readonly number[]): Summary {
  if (!values.length) return { n: 0, mean: 0, max: 0, p95: 0 };
  const xs = [...values].sort((a, b) => a - b);
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return { n: xs.length, mean, p95: xs[Math.floor(xs.length * 0.95)] ?? 0, max: xs.at(-1) ?? 0 };
}
