// A fixed window of the most recent samples, with the summary numbers we publish
// (/api/stats). Used for tick duration and tick lateness (jitter).

export interface RollingSummary {
  readonly n: number;
  readonly mean: number;
  readonly stdev: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
}

export class RollingStats {
  #values: Float64Array;
  #next = 0;
  #count = 0;

  constructor(size = 300) {
    this.#values = new Float64Array(size);
  }

  add(v: number): void {
    this.#values[this.#next] = v;
    this.#next = (this.#next + 1) % this.#values.length;
    this.#count = Math.min(this.#count + 1, this.#values.length);
  }

  get count(): number {
    return this.#count;
  }

  summary(): RollingSummary {
    const n = this.#count;
    if (n === 0) return { n: 0, mean: 0, stdev: 0, p50: 0, p99: 0, max: 0 };
    const xs = Array.from(this.#values.subarray(0, n)).sort((a, b) => a - b);
    const mean = xs.reduce((s, x) => s + x, 0) / n;
    const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
    const at = (q: number): number => xs[Math.min(n - 1, Math.floor(q * n))] ?? 0;
    const r = (x: number): number => Math.round(x * 1000) / 1000;
    return {
      n,
      mean: r(mean),
      stdev: r(Math.sqrt(variance)),
      p50: r(at(0.5)),
      p99: r(at(0.99)),
      max: r(xs[n - 1] ?? 0),
    };
  }
}
