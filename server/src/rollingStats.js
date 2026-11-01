// A fixed window of the most recent samples, with the summary numbers we publish
// (/api/stats). Used for tick duration and tick lateness (jitter).

export class RollingStats {
  #values;
  #next = 0;
  #count = 0;

  constructor(size = 300) {
    this.#values = new Float64Array(size);
  }

  add(v) {
    this.#values[this.#next] = v;
    this.#next = (this.#next + 1) % this.#values.length;
    this.#count = Math.min(this.#count + 1, this.#values.length);
  }

  get count() {
    return this.#count;
  }

  summary() {
    const n = this.#count;
    if (n === 0) return { n: 0, mean: 0, stdev: 0, p50: 0, p99: 0, max: 0 };
    const xs = Array.from(this.#values.subarray(0, n)).sort((a, b) => a - b);
    const mean = xs.reduce((s, x) => s + x, 0) / n;
    const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
    const at = (q) => xs[Math.min(n - 1, Math.floor(q * n))];
    const r = (x) => Math.round(x * 1000) / 1000;
    return {
      n,
      mean: r(mean),
      stdev: r(Math.sqrt(variance)),
      p50: r(at(0.5)),
      p99: r(at(0.99)),
      max: r(xs[n - 1]),
    };
  }
}
