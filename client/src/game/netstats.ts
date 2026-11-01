// What the netgraph shows (Lab 5, §7): RTT, snapshot age and rhythm, bytes per second, queued
// inputs, reconciliation error. Pure bookkeeping with an injected clock, so it is testable.

const WINDOW_MS = 1000;
const RECENT = 150; // the netgraph's "recent": 150 snapshots = 5 s

/** Bytes-per-second over a sliding window. */
class Rate {
  #events: [at: number, bytes: number][] = [];
  add(now: number, bytes: number): void {
    this.#events.push([now, bytes]);
  }
  perSecond(now: number): number {
    while (this.#events.length && now - (this.#events[0]?.[0] ?? now) > WINDOW_MS)
      this.#events.shift();
    return this.#events.reduce((sum, [, b]) => sum + b, 0) / (WINDOW_MS / 1000);
  }
}

class History {
  readonly values: number[] = [];
  readonly size: number;
  constructor(size = 120) {
    this.size = size;
  }
  push(v: number): void {
    this.values.push(v);
    if (this.values.length > this.size) this.values.shift();
  }
  get last(): number {
    return this.values.at(-1) ?? 0;
  }
  get max(): number {
    return this.values.length ? Math.max(...this.values) : 0;
  }
  get mean(): number {
    return this.values.length ? this.values.reduce((s, v) => s + v, 0) / this.values.length : 0;
  }
  /** The newest `n` values — what the netgraph shows, while `values` keeps a longer record. */
  recent(n: number): number[] {
    return this.values.slice(-n);
  }
}

export interface NetReport {
  readonly rttMs: number;
  readonly rttMeanMs: number;
  readonly rttJitterMs: number;
  readonly snapshotAgeMs: number;
  readonly snapshotIntervalMs: number;
  readonly snapshotIntervalMaxMs: number;
  readonly downBytesPerSec: number;
  readonly upBytesPerSec: number;
  readonly pendingInputs: number;
  readonly correction: number;
  readonly correctionMean: number;
  readonly correctionMax: number;
  readonly teleports: number;
  readonly snapshots: number;
  readonly lostSnapshots: number;
  readonly lossPercent: number;
  readonly starvedFrames: number;
  readonly starvedPercent: number;
  readonly badFrames: number;
  readonly avgSnapshotBytes: number;
}

export class NetStats {
  readonly now: () => number;
  readonly down = new Rate();
  readonly up = new Rate();
  readonly rtt = new History(120);
  readonly corrections = new History(6000); // 200 s of snapshots: long enough to MEASURE with; the graph shows the last 5 s
  readonly intervals = new History(90); // ms between snapshot arrivals
  readonly snapshotBytes = new History(60);
  lastSnapshotAt: number | null = null;
  lastSnapshotTick = 0;
  snapshots = 0;
  lost = 0; // ticks that never arrived
  starved = 0; // render frames that ran out of snapshots
  frames = 0;
  pending = 0;
  teleports = 0;
  badFrames = 0;

  constructor({ now = () => performance.now() }: { now?: () => number } = {}) {
    this.now = now;
  }

  onFrame(bytes: number): void {
    this.down.add(this.now(), bytes);
  }

  onSend(bytes: number): void {
    this.up.add(this.now(), bytes);
  }

  onSnapshot(snapshot: { readonly tick: number }, bytes: number): void {
    const t = this.now();
    if (this.lastSnapshotAt !== null) this.intervals.push(t - this.lastSnapshotAt);
    if (this.lastSnapshotTick && snapshot.tick > this.lastSnapshotTick + 1) {
      this.lost += snapshot.tick - this.lastSnapshotTick - 1;
    }
    this.lastSnapshotAt = t;
    this.lastSnapshotTick = snapshot.tick;
    this.snapshots++;
    if (bytes) this.snapshotBytes.push(bytes);
  }

  onPong(rttMs: number): void {
    this.rtt.push(rttMs);
  }

  onCorrection(units: number): void {
    this.corrections.push(units);
  }

  /** The server moved our ship far away (a respawn): not a prediction error. */
  onTeleport(): void {
    this.teleports++;
  }

  onRender(starved: boolean): void {
    this.frames++;
    if (starved) this.starved++;
  }

  /** The numbers as one plain object (for the netgraph and for `window.__net`). */
  report(): NetReport {
    const t = this.now();
    const jitter = this.rtt.values.length > 1 ? stdev(this.rtt.values) : 0;
    return {
      rttMs: this.rtt.last,
      rttMeanMs: this.rtt.mean,
      rttJitterMs: jitter,
      snapshotAgeMs: this.lastSnapshotAt === null ? Infinity : t - this.lastSnapshotAt,
      snapshotIntervalMs: this.intervals.mean,
      snapshotIntervalMaxMs: this.intervals.max,
      downBytesPerSec: this.down.perSecond(t),
      upBytesPerSec: this.up.perSecond(t),
      pendingInputs: this.pending,
      correction: this.corrections.last,
      correctionMean: mean(this.corrections.recent(RECENT)),
      correctionMax: Math.max(0, ...this.corrections.recent(RECENT)),
      teleports: this.teleports,
      snapshots: this.snapshots,
      lostSnapshots: this.lost,
      lossPercent:
        this.snapshots + this.lost ? (100 * this.lost) / (this.snapshots + this.lost) : 0,
      starvedFrames: this.starved,
      starvedPercent: this.frames ? (100 * this.starved) / this.frames : 0,
      badFrames: this.badFrames,
      avgSnapshotBytes: this.snapshotBytes.mean,
    };
  }
}

function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function stdev(xs: readonly number[]): number {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
}

export { History };
