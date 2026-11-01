// One authoritative match per room: the ONE true simulation.
//
//   clients send INPUTS (never positions) ──► per-player queue ──► applied in order, one step
//   each, every tick ──► world.step(dt) ──► a SNAPSHOT per client (with that client's `ack`)
//
// The tick loop is a chain of `setTimeout`s aimed at ABSOLUTE times (`nextAt += 33.3 ms`),
// never `setInterval` — see `#onTimer`.

import { randomInt } from "node:crypto";
import {
  INPUT_BURST,
  INPUT_RATE_PER_SEC,
  NO_SEQ,
  STEP,
  STEP_MS,
  TICK_ZERO,
  World,
  buildSnapshot,
  type InputMessage,
  type Seq,
  type Ship,
  type Tick,
} from "@dogfight/shared";
import type { Logger } from "./logger.ts";
import { RollingStats, type RollingSummary } from "./rollingStats.ts";
import { TokenBucket } from "./rateLimit.ts";
import type { Player, Room } from "./rooms.ts";
import { unrefSchedule, type Schedule } from "./schedule.ts";

const MAX_CATCH_UP_TICKS = 5; // behind by more than this → skip ahead instead of racing to catch up
const MAX_QUEUE = 200;
const KICK_AFTER_REJECTED = 300; // inputs refused by the rate limit in a row before we cut the client

/** Per-player bookkeeping inside a match. */
interface PlayerState {
  readonly player: Player;
  readonly ship: Ship;
  readonly queue: InputMessage[];
  lastSeq: Seq; // last input seq APPLIED — this is the `ack` in every snapshot
  lastQueued: Seq; // newest seq accepted into the queue (rejects duplicates and stragglers)
  clientTick: Tick;
  rejected: number;
  rejectedInARow: number;
  readonly bucket: TokenBucket;
}

/** Clock and timers, injectable so tests can control time. */
export interface MatchDeps {
  now?: () => number;
  schedule?: Schedule;
}

export interface MatchOptions {
  room: Room;
  /** The world's random seed (sent to clients in `joined`). */
  seed?: number;
  log?: Logger;
  /**
   * A jitter buffer: after each tick, try to leave this many
   *        inputs queued. 0 = apply every input that has arrived (the textbook rule). With jitter,
   *        inputs arrive in bunches — none this tick, two the next — and a ship fed that way
   *        moves in lurches that every OTHER player sees; keeping one input in reserve turns
   *        bursts back into one step per tick, at the price of one tick (33 ms) of extra delay.
   */
  inputReserve?: number;
  deps?: MatchDeps;
}

export interface MatchSummary {
  readonly room: string;
  readonly tick: Tick;
  readonly players: number;
  readonly entities: number;
  readonly tickDurationMs: RollingSummary;
  readonly tickLatenessMs: RollingSummary;
  readonly tickIntervalMs: RollingSummary;
  readonly overruns: number;
  readonly skippedTicks: number;
  readonly inputsApplied: number;
  readonly inputsRejected: number;
  readonly bytesOutPerSec: number;
}

export class Match {
  readonly room: Room;
  readonly inputReserve: number;
  readonly log: Logger | undefined;
  readonly seed: number;
  readonly now: () => number;
  readonly schedule: Schedule;
  readonly world: World;
  readonly players = new Map<string, PlayerState>(); // player.id → state

  /** Called at the start of every tick, before inputs are applied (the bots use it). */
  readonly beforeStep = new Set<() => void>();
  running = false;
  #cancelTimer: (() => void) | null = null;
  nextAt = 0;
  startedAt = 0;
  readonly stats = {
    duration: new RollingStats(), // ms a tick took to compute
    lateness: new RollingStats(), // ms the tick started AFTER its scheduled time = timer jitter
    interval: new RollingStats(), // ms between two consecutive tick starts (ideal: 33.33)
    overruns: 0, // ticks that took longer than their budget
    skipped: 0, // ticks dropped because we fell too far behind
    inputsApplied: 0,
    inputsRejected: 0,
    bytesOut: 0,
  };
  lastStart: number | null = null;

  constructor({
    room,
    seed = randomInt(0, 2 ** 32),
    log,
    inputReserve = 0,
    deps = {},
  }: MatchOptions) {
    this.room = room;
    this.inputReserve = inputReserve;
    this.log = log;
    this.seed = seed;
    this.now = deps.now ?? (() => performance.now());
    this.schedule = deps.schedule ?? unrefSchedule; // a match must never be the reason the process cannot exit
    this.world = new World({ seed, arena: room.arena }).populate();
  }

  get tick(): Tick {
    return this.world.tick;
  }

  // ---- players ------------------------------------------------------------------------

  /** Called when a player joins the room: gives them a ship and starts the clock if needed. */
  addPlayer(player: Player): Ship {
    const ship = this.world.addShip(player.id);
    player.shipId = ship.id;
    this.players.set(player.id, {
      player,
      ship,
      queue: [],
      lastSeq: NO_SEQ,
      lastQueued: NO_SEQ,
      clientTick: TICK_ZERO,
      rejected: 0,
      rejectedInARow: 0,
      bucket: new TokenBucket({ capacity: INPUT_BURST, perSec: INPUT_RATE_PER_SEC, now: this.now }),
    });
    this.start();
    return ship;
  }

  removePlayer(player: Player): void {
    const st = this.players.get(player.id);
    if (!st) return;
    this.players.delete(player.id);
    this.world.despawn(st.ship.id);
    if (this.players.size === 0) this.stop();
  }

  /**
   * An input from a client (already decoded and shape-checked). The server's checks:
   *   - not older than what it already accepted (a duplicate or a straggler),
   *   - within the input rate budget (about 1.1× the tick rate, plus a burst for jitter) —
   *     anything faster than that would be a speed hack, so it is simply not applied.
   */
  receiveInput(player: Player, input: InputMessage): boolean {
    const st = this.players.get(player.id);
    if (!st) return false;
    if (input.seq <= st.lastQueued) return false;
    if (!st.bucket.take()) {
      st.rejected++;
      st.rejectedInARow++;
      this.stats.inputsRejected++;
      if (st.rejectedInARow >= KICK_AFTER_REJECTED) player.kick("input flood");
      return false;
    }
    st.rejectedInARow = 0;
    st.lastQueued = input.seq;
    st.clientTick = input.tick;
    if (st.queue.length >= MAX_QUEUE) st.queue.shift();
    st.queue.push(input);
    return true;
  }

  // ---- the clock ----------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();
    this.nextAt = this.startedAt + STEP_MS;
    this.lastStart = null;
    this.#schedule();
  }

  stop(): void {
    this.running = false;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
  }

  #schedule(): void {
    const delay = Math.max(0, this.nextAt - this.now());
    this.#cancelTimer = this.schedule(() => this.#onTimer(), delay);
  }

  /**
   * Why `setTimeout` against an absolute target and not `setInterval(tick, 33)`:
   *   - setInterval re-arms relative to when the callback RAN, so every late tick pushes all
   *     the following ones later too (drift), and a few late callbacks can run back to back;
   *   - here each tick is aimed at `startedAt + n × 33.33 ms`. If one is 3 ms late the next
   *     wait is simply 3 ms shorter, so lateness does not accumulate: the average rate stays
   *     exactly 30 Hz;
   *   - a tick that takes LONGER than the interval (we are CPU-bound) is detected as
   *     "behind": we run the next ones immediately to catch up, and if we fall more than
   *     MAX_CATCH_UP_TICKS behind we skip ahead rather than spiral.
   */
  #onTimer(): void {
    if (!this.running) return;
    const started = this.now();
    this.stats.lateness.add(Math.max(0, started - this.nextAt));
    if (this.lastStart !== null) this.stats.interval.add(started - this.lastStart);
    this.lastStart = started;

    try {
      this.step();
    } catch (err: unknown) {
      this.log?.error("tick failed", {
        room: this.room.id,
        error: err instanceof Error ? err.stack : String(err),
      });
    }

    const finished = this.now();
    this.stats.duration.add(finished - started);
    this.nextAt += STEP_MS;
    const behind = finished - this.nextAt;
    if (behind > 0) this.stats.overruns++;
    if (behind > STEP_MS * MAX_CATCH_UP_TICKS) {
      const lost = Math.floor(behind / STEP_MS);
      this.stats.skipped += lost;
      this.log?.warn("match is too slow, skipping ticks", { room: this.room.id, lost });
      this.nextAt = finished + STEP_MS;
    }
    this.#schedule();
  }

  // ---- one tick -----------------------------------------------------------------------

  /** Apply inputs → step the world → send a snapshot to everyone. Public so tests can drive it. */
  step(): void {
    for (const hook of this.beforeStep) hook();
    for (const st of this.players.values()) {
      const backlog = st.queue.length;
      let take = backlog <= 1 ? backlog : Math.max(1, backlog - this.inputReserve);
      if (this.inputReserve === 0) take = backlog;
      while (take-- > 0) {
        const input = st.queue.shift();
        if (!input) break; // cannot happen: `take` never exceeds the backlog
        this.world.applyInput(st.ship, input, STEP);
        st.lastSeq = input.seq;
        this.stats.inputsApplied++;
      }
    }
    this.world.step(STEP);

    const events = this.world.drainEvents();
    for (const { type, ...data } of events) this.room.record(type, data); // the match log (Lab 4)

    for (const st of this.players.values()) {
      const snapshot = buildSnapshot(this.world, { shipId: st.ship.id, ack: st.lastSeq, events });
      const bytes = st.player.deliver(snapshot);
      this.stats.bytesOut += bytes;
    }
  }

  // ---- numbers for /api/stats ---------------------------------------------------------

  summary(): MatchSummary {
    const seconds = Math.max(0.001, (this.now() - this.startedAt) / 1000);
    return {
      room: this.room.id,
      tick: this.tick,
      players: this.players.size,
      entities: this.world.size,
      tickDurationMs: this.stats.duration.summary(),
      tickLatenessMs: this.stats.lateness.summary(),
      tickIntervalMs: this.stats.interval.summary(),
      overruns: this.stats.overruns,
      skippedTicks: this.stats.skipped,
      inputsApplied: this.stats.inputsApplied,
      inputsRejected: this.stats.inputsRejected,
      bytesOutPerSec: this.running ? Math.round(this.stats.bytesOut / seconds) : 0,
    };
  }
}
