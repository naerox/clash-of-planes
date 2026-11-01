// Cheap, allocation-free timing of the hot paths, for the profiling in Lab 7.
//
// `performance.mark/measure` allocates a PerformanceEntry per call — measuring the garbage
// collector with something that makes garbage would be silly. So every span is two reads of
// `performance.now()` and one write into a preallocated `Float64Array` ring. The spans show up
// in DevTools' User Timing track only when the page is opened with `?trace=1` (then each
// `record` also calls `performance.measure`, and the numbers are no longer allocation-free).
//
//   const t = performance.now();  …work…;  record(SPAN.render, t);
//   window.__perf.report()  →  { simulate: { n, p50, p95, p99, max, mean }, … }

const NAMES = ["simulate", "render", "decode", "reconcile", "frame", "interval"] as const;
export type SpanName = (typeof NAMES)[number];
/** The index of each span, as a plain number so recording needs no string lookup. */
export const SPAN = {
  simulate: 0,
  render: 1,
  decode: 2,
  reconcile: 3,
  frame: 4, // CPU time of one whole frame: all the simulation steps plus the render
  interval: 5, // wall-clock time between two frames
} satisfies Record<SpanName, number>;

const RING = 8192; // ~2 minutes of frames at 60 fps
const rings = NAMES.map(() => new Float64Array(RING));
const counts = NAMES.map(() => 0);
let userTiming = false;

export function enableUserTiming(on: boolean): void {
  userTiming = on;
}

/** Records the time since `startMs` under `span`. */
export function record(span: number, startMs: number): void {
  const end = performance.now();
  store(span, end - startMs);
  if (userTiming) performance.measure(NAMES[span] ?? "?", { start: startMs, end });
}

/** Records an already-measured duration. */
export function store(span: number, ms: number): void {
  const ring = rings[span];
  if (!ring) return;
  ring[(counts[span] ?? 0) % RING] = ms;
  counts[span] = (counts[span] ?? 0) + 1;
}

export interface SpanStats {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function stats(name: SpanName): SpanStats {
  const span = SPAN[name];
  const n = Math.min(counts[span] ?? 0, RING);
  const ring = rings[span];
  if (!ring || n === 0) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const xs = Array.from(ring.subarray(0, n)).sort((a, b) => a - b);
  const at = (q: number): number => xs[Math.min(n - 1, Math.floor(q * n))] ?? 0;
  const round = (x: number): number => Math.round(x * 1000) / 1000;
  return {
    n,
    mean: round(xs.reduce((s, x) => s + x, 0) / n),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(xs[n - 1] ?? 0),
  };
}

export function report(): Record<SpanName, SpanStats> {
  return {
    simulate: stats("simulate"),
    render: stats("render"),
    decode: stats("decode"),
    reconcile: stats("reconcile"),
    frame: stats("frame"),
    interval: stats("interval"),
  };
}

export function reset(): void {
  counts.fill(0);
}
