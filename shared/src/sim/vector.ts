// A small immutable 2D vector. Every method returns a NEW Vector2 and never touches `this`
// or its argument — `a.add(b)` leaves both `a` and `b` untouched. Lab 6 makes that a compiler
// guarantee: the fields are `readonly`, so `v.x = 5` does not compile.
// That purity is what makes `previous`/`current` entity snapshots (Lab 1) safe to keep
// as plain references: nothing in the sim ever mutates a vector once it exists.
export class Vector2 {
  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  static get zero(): Vector2 {
    return new Vector2(0, 0);
  }

  add(v: Vector2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v: Vector2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k: number): Vector2 {
    return new Vector2(this.x * k, this.y * k);
  }

  dot(v: Vector2): number {
    return this.x * v.x + this.y * v.y;
  }

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  /** Returns a unit vector in the same direction, or (0,0) if this vector is (0,0). */
  normalize(): Vector2 {
    const len = this.length();
    return len === 0 ? Vector2.zero : this.scale(1 / len);
  }

  rotate(angle: number): Vector2 {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vector2(this.x * cos - this.y * sin, this.x * sin + this.y * cos);
  }

  angle(): number {
    return Math.atan2(this.y, this.x);
  }
}
