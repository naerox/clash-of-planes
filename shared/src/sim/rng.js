// A seeded pseudo-random generator (mulberry32). The simulation may never call
// `Math.random()`: two machines would roll different numbers and drift apart. Instead the
// server picks a seed per match and every random choice in the sim comes from this stream,
// consumed in the same order on both sides.
//
// The whole state is one 32-bit integer, so it can be hashed, logged and restored.

export class Rng {
  /** @param {number} seed any integer; it is reduced to an unsigned 32-bit value */
  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  /** A float in [0, 1), like Math.random(). */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A float in [min, max). */
  range(min, max) {
    return min + this.next() * (max - min);
  }

  /** An integer in [0, n). */
  int(n) {
    return Math.floor(this.next() * n);
  }

  /** True with probability p. */
  chance(p) {
    return this.next() < p;
  }
}
