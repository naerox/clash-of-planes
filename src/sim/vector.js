// A small immutable-style 2D vector. Every method returns a NEW Vector2 and never
// touches `this` or its argument — `a.add(b)` leaves both `a` and `b` untouched.
// That purity is what makes `previous`/`current` entity snapshots (Lab 1) safe to keep
// as plain references: nothing in the sim ever mutates a vector once it exists.
export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle, length = 1) {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  static get zero() {
    return new Vector2(0, 0);
  }

  add(v) {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v) {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k) {
    return new Vector2(this.x * k, this.y * k);
  }

  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  length() {
    return Math.hypot(this.x, this.y);
  }

  /** Returns a unit vector in the same direction, or (0,0) if this vector is (0,0). */
  normalize() {
    const len = this.length();
    return len === 0 ? Vector2.zero : this.scale(1 / len);
  }

  rotate(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vector2(this.x * cos - this.y * sin, this.x * sin + this.y * cos);
  }

  angle() {
    return Math.atan2(this.y, this.x);
  }

  /** Hot-path variants: mutate `this` in place instead of allocating. Use only where
   * profiling (Lab 7) shows allocation matters — everywhere else, prefer the pure methods
   * above, because a function that never mutates its arguments is much easier to reason about. */
  addInPlace(v) {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  scaleInPlace(k) {
    this.x *= k;
    this.y *= k;
    return this;
  }
}
