import test from "node:test";
import assert from "node:assert/strict";
import { ParticleSystem } from "./particles.ts";

test("a burst makes sparks that fly outwards, fade and disappear", () => {
  const ps = new ParticleSystem();
  ps.burst(100, 100, 12, () => 0.5);
  assert.equal(ps.size, 12);
  ps.update(0.1);
  assert.ok(ps.list.every((p) => p.life < 1 && p.life > 0));
  assert.ok(ps.list.every((p) => p.x !== 100 || p.y !== 100));
  for (let i = 0; i < 20; i++) ps.update(0.1);
  assert.equal(ps.size, 0);
});
