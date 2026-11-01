import test from "node:test";
import assert from "node:assert/strict";
import { interpolatedPose, lerpAngle, lerpVec, lerpWrapped } from "./interpolate.ts";
import { ARENA, Bullet, Pickup, Ship, Vector2 } from "@dogfight/shared";

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
  const ship = new Ship(new Vector2(2, 450));
  ship.prevPos = new Vector2(1598, 450);
  ship.prevAngle = ship.angle;
  const bullet = new Bullet(new Vector2(2, 450), Vector2.zero, ship);
  bullet.prevPos = new Vector2(1598, 450);
  const shipPose = interpolatedPose(ship, 0.5);
  const bulletPose = interpolatedPose(bullet, 0.5);
  assert.ok(shipPose.pos.x < 2 || shipPose.pos.x > 1598, "ship takes the short wrapped path");
  assert.ok(Math.abs(bulletPose.pos.x - 800) < 1e-9, "bullet is linearly interpolated, no wrap");
});

test("a fresh entity has prevPos = pos, so there is nothing to interpolate on its first tick", () => {
  const e = new Pickup(new Vector2(5, 5));
  const pose = interpolatedPose(e, 0.7);
  assert.deepEqual(pose.pos, new Vector2(5, 5));
  assert.equal(pose.angle, 0);
});
