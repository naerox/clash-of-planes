// What the netgraph shows (Lab 5, §7): RTT, snapshot age and rhythm, bytes per second, queued
// inputs, reconciliation error. Pure bookkeeping with an injected clock, so it is testable.

const WINDOW_MS = 1000;
const RECENT = 150; // the netgraph's "recent": 150 snapshots = 5 s

/** Bytes-per-second over a sliding window. */
class Rate {
  #events = [];
  add(now, bytes) {
    this.#events.push([now, bytes]);
  }
  perSecond(now) {
    while (this.#events.length && now - this.#events[0][0] > WINDOW_MS) this.#events.shift();
    return this.#events.reduce((sum, [, b]) => sum + b, 0) / (WINDOW_MS / 1000);
  }
}

class History {
  constructor(size = 120) {
    this.size = size;
    this.values = [];
  }
  push(v) {
    this.values.push(v);
    if (this.values.length > this.size) this.values.shift();
  }
  get last() {
    return this.values.at(-1) ?? 0;
  }
  get max() {
    return this.values.length ? Math.max(...this.values) : 0;
  }
  get mean() {
    return this.values.length ? this.values.reduce((s, v) => s + v, 0) / this.values.length : 0;
  }
  /** The newest `n` values — what the netgraph shows, while `values` keeps a longer record. */
  recent(n) {
    return this.values.slice(-n);
  }
}

export class NetStats {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.down = new Rate();
    this.up = new Rate();
    this.rtt = new History(120);
    this.corrections = new History(6000); // 200 s of snapshots: long enough to MEASURE with; the graph shows the last 5 s
    this.intervals = new History(90); // ms between snapshot arrivals
    this.lastSnapshotAt = null;
    this.lastSnapshotTick = 0;
    this.snapshots = 0;
    this.lost = 0; // ticks that never arrived
    this.starved = 0; // render frames that ran out of snapshots
    this.frames = 0;
    this.pending = 0;
    this.teleports = 0;
    this.badFrames = 0;
    this.snapshotBytes = new History(60);
  }

  onFrame(bytes) {
    this.down.add(this.now(), bytes);
  }

  onSend(bytes) {
    this.up.add(this.now(), bytes);
  }

  onSnapshot(snapshot, bytes) {
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

  onPong(rttMs) {
    this.rtt.push(rttMs);
  }

  onCorrection(units) {
    this.corrections.push(units);
  }

  /** The server moved our ship far away (a respawn): not a prediction error. */
  onTeleport() {
    this.teleports++;
  }

  onRender(starved) {
    this.frames++;
    if (starved) this.starved++;
  }

  /** The numbers as one plain object (for the netgraph and for `window.__net`). */
  report() {
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

function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function stdev(xs) {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
}

export { History };
