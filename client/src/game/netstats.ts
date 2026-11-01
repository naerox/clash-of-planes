// What the netgraph shows (Lab 5, §7): RTT, snapshot age and rhythm, bytes per second, queued
// inputs, reconciliation error. Pure bookkeeping with an injected clock, so it is testable.

const WINDOW_MS = 1000;
const RECENT = 150; // the netgraph's "recent": 150 snapshots = 5 s

/**
 * Bytes-per-second over a sliding window — in two preallocated ring buffers, so recording an
 * event and asking for the rate allocate nothing (Lab 7: this used to push a `[time, bytes]` tuple
 * per frame and `shift()`/`reduce()` them, which the allocation profile ranked first).
 */
class Rate {
  readonly #at = new Float64Array(512);
  readonly #bytes = new Float64Array(512);
  #head = 0; // index of the oldest event
  #size = 0;

  add(now: number, bytes: number): void {
    const cap = this.#at.length;
    if (this.#size === cap) {
      this.#head = (this.#head + 1) % cap; // full: forget the oldest
      this.#size--;
    }
    const slot = (this.#head + this.#size) % cap;
    this.#at[slot] = now;
    this.#bytes[slot] = bytes;
    this.#size++;
  }

  perSecond(now: number): number {
    const cap = this.#at.length;
    while (this.#size > 0 && now - (this.#at[this.#head] ?? now) > WINDOW_MS) {
      this.#head = (this.#head + 1) % cap;
      this.#size--;
    }
    let sum = 0;
    for (let i = 0; i < this.#size; i++) sum += this.#bytes[(this.#head + i) % cap] ?? 0;
    return sum / (WINDOW_MS / 1000);
  }
}

/**
 * The last `size` numbers, in a typed-array ring. Every statistic is a loop over the ring: no
 * `Math.max(...values)` (a spread of thousands of arguments), no `slice`, no `reduce` callback.
 */
class History {
  readonly size: number;
  readonly #ring: Float64Array;
  #next = 0;
  #count = 0;

  constructor(size = 120) {
    this.size = size;
    this.#ring = new Float64Array(size);
  }

  push(v: number): void {
    this.#ring[this.#next] = v;
    this.#next = (this.#next + 1) % this.size;
    if (this.#count < this.size) this.#count++;
  }

  get length(): number {
    return this.#count;
  }

  /** The `i`-th newest value (0 = the last one pushed). */
  fromEnd(i: number): number {
    return this.#ring[(this.#next - 1 - i + 2 * this.size) % this.size] ?? 0;
  }

  get last(): number {
    return this.#count ? this.fromEnd(0) : 0;
  }

  get max(): number {
    return this.maxOfLast(this.#count);
  }

  get mean(): number {
    return this.meanOfLast(this.#count);
  }

  maxOfLast(n: number): number {
    const m = Math.min(n, this.#count);
    let max = 0;
    for (let i = 0; i < m; i++) {
      const v = this.fromEnd(i);
      if (i === 0 || v > max) max = v;
    }
    return max;
  }

  meanOfLast(n: number): number {
    const m = Math.min(n, this.#count);
    let sum = 0;
    for (let i = 0; i < m; i++) sum += this.fromEnd(i);
    return m ? sum / m : 0;
  }

  /** Population standard deviation of everything held. */
  get stdev(): number {
    const mean = this.mean;
    let sum = 0;
    for (let i = 0; i < this.#count; i++) sum += (this.fromEnd(i) - mean) ** 2;
    return this.#count ? Math.sqrt(sum / this.#count) : 0;
  }

  /** Writes the newest `n` values, oldest first, into `out`; returns how many. For the sparklines. */
  copyRecent(n: number, out: Float64Array): number {
    const m = Math.min(n, this.#count, out.length);
    for (let i = 0; i < m; i++) out[m - 1 - i] = this.fromEnd(i);
    return m;
  }

  /** A fresh array, oldest first. Allocates: for tests and scripts, not for the frame loop. */
  get values(): number[] {
    return Array.from({ length: this.#count }, (_, i) => this.fromEnd(this.#count - 1 - i));
  }

  /** The newest `n` values as a fresh array. Allocates: see `copyRecent`. */
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

  #live: NetReport | null = null;
  #liveAt = -Infinity;

  /**
   * The same numbers, but recomputed at most every 100 ms and handed out as the SAME object in
   * between. The netgraph and the HUD ask every frame; at 60 fps that is six reports' worth of
   * work (and six objects) thrown away for each one anyone could actually read.
   */
  liveReport(): NetReport {
    const t = this.now();
    if (this.#live === null || t - this.#liveAt >= 100) {
      this.#live = this.report();
      this.#liveAt = t;
    }
    return this.#live;
  }

  /** The numbers as one plain object (for tests and for `window.__net`): always fresh. */
  report(): NetReport {
    const t = this.now();
    const jitter = this.rtt.length > 1 ? this.rtt.stdev : 0;
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
      correctionMean: this.corrections.meanOfLast(RECENT),
      correctionMax: this.corrections.maxOfLast(RECENT),
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

export { History };
