import test from "node:test";
import assert from "node:assert/strict";
import { Vector2 } from "./vector.js";

test("add/sub/scale never mutate their operands", () => {
  const a = new Vector2(1, 2);
  const b = new Vector2(3, 4);
  const frozenA = Object.freeze(new Vector2(a.x, a.y));
  const frozenB = Object.freeze(new Vector2(b.x, b.y));
  assert.doesNotThrow(() => {
    frozenA.add(frozenB);
    frozenA.sub(frozenB);
    frozenA.scale(5);
  });
  assert.deepEqual(a, new Vector2(1, 2));
  assert.deepEqual(b, new Vector2(3, 4));
});

test("add/sub/scale/dot produce correct values", () => {
  const a = new Vector2(1, 2);
  const b = new Vector2(3, 4);
  assert.deepEqual(a.add(b), new Vector2(4, 6));
  assert.deepEqual(a.sub(b), new Vector2(-2, -2));
  assert.deepEqual(a.scale(3), new Vector2(3, 6));
  assert.equal(a.dot(b), 1 * 3 + 2 * 4);
});

test("fromAngle/length/normalize round-trip", () => {
  const v = Vector2.fromAngle(Math.PI / 2, 10);
  assert.ok(Math.abs(v.x) < 1e-9);
  assert.ok(Math.abs(v.y - 10) < 1e-9);
  assert.ok(Math.abs(v.length() - 10) < 1e-9);
  assert.ok(Math.abs(v.normalize().length() - 1) < 1e-9);
});

test("normalize of the zero vector returns zero, not NaN", () => {
  const z = Vector2.zero.normalize();
  assert.equal(z.x, 0);
  assert.equal(z.y, 0);
});

test("rotate by a full turn returns (approximately) the original vector", () => {
  const v = new Vector2(5, 0).rotate(Math.PI * 2);
  assert.ok(Math.abs(v.x - 5) < 1e-9);
  assert.ok(Math.abs(v.y - 0) < 1e-9);
});
