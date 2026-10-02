import test from "node:test";
import assert from "node:assert/strict";
import { interpolatedPose, lerpAngle, lerpVec, lerpWrapped } from "./interpolate.js";
import { ARENA } from "../sim/arena.js";
import { Vector2 } from "../sim/vector.js";

test("lerpAngle crosses ±PI the short way", () => {
  const mid = lerpAngle(3.1, -3.1, 0.5);
  assert.ok(Math.abs(Math.abs(mid) - Math.PI) < 0.05, `mid = ${mid}`);
});

test("lerpWrapped crosses an arena edge without sweeping the arena", () => {
  const x = lerpWrapped(1598, 2, 0.5, ARENA.width);
  assert.ok(x < 2 || x > 1598, `x = ${x}`);
});

test("lerpVec does NOT take the wrapped short path — plain linear interpolation", () => {
  const a = new Vector2(1598, 0);
  const b = new Vector2(2, 0);
  const mid = lerpVec(a, b, 0.5);
  assert.ok(Math.abs(mid.x - 800) < 1e-9, `non-ship entities must not wrap, got x=${mid.x}`);
});

test("interpolatedPose: a ship wraps, a bullet does not", () => {
  const ship = {
    kind: "ship",
    prevPos: new Vector2(1598, 450),
    pos: new Vector2(2, 450),
    prevAngle: 0,
    angle: 0,
  };
  const bullet = {
    kind: "bullet",
    prevPos: new Vector2(1598, 450),
    pos: new Vector2(2, 450),
    prevAngle: 0,
    angle: 0,
  };
  const shipPose = interpolatedPose(ship, 0.5);
  const bulletPose = interpolatedPose(bullet, 0.5);
  assert.ok(shipPose.pos.x < 2 || shipPose.pos.x > 1598, "ship takes the short wrapped path");
  assert.ok(Math.abs(bulletPose.pos.x - 800) < 1e-9, "bullet is linearly interpolated, no wrap");
});

test("interpolatedPose falls back to pos/angle when prevPos is missing (first tick)", () => {
  const e = { kind: "particle", pos: new Vector2(5, 5), angle: 1.2 };
  const pose = interpolatedPose(e, 0.7);
  assert.deepEqual(pose.pos, new Vector2(5, 5));
  assert.equal(pose.angle, 1.2);
});
