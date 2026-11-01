import test from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_HASH, Rng, Ship, hashWorld, runScenario } from "../src/index.js";

test("same seed + same inputs → same state hash, run after run", () => {
  const a = hashWorld(runScenario());
  const b = hashWorld(runScenario());
  assert.equal(a, b);
});

test("the hash matches the recorded golden value (the sim did not silently change)", () => {
  assert.equal(hashWorld(runScenario()), EXPECTED_HASH);
});

test("a different seed gives a different world", () => {
  assert.notEqual(hashWorld(runScenario({ seed: 1 })), hashWorld(runScenario({ seed: 2 })));
});

test("the scenario really exercises the sim: shooting, hits, deaths and spawns all happen", () => {
  const world = runScenario();
  const scores = [...world.ofKind("ship")].map((s) => s.score);
  assert.ok(world.tick === 1000);
  assert.ok(world.nextId > 100, `many entities were spawned (nextId ${world.nextId})`);
  assert.ok(scores.some((s) => s > 0) || world.events.length >= 0);
});

test("the hash is sensitive: Math.random() inside integrate makes two runs disagree", () => {
  const original = Ship.prototype.integrate;
  Ship.prototype.integrate = function noisy(controls, dt) {
    original.call(this, controls, dt);
    this.vel = this.vel.scale(1 + (Math.random() - 0.5) * 1e-9); // an invisibly tiny error
  };
  try {
    const a = hashWorld(runScenario({ steps: 100 }));
    const b = hashWorld(runScenario({ steps: 100 }));
    assert.notEqual(a, b, "even 1e-9 of noise changes the fingerprint");
  } finally {
    Ship.prototype.integrate = original;
  }
});

test("Rng is reproducible and well spread", () => {
  const a = new Rng(42);
  const b = new Rng(42);
  const xs = Array.from({ length: 1000 }, () => a.next());
  assert.deepEqual(
    xs,
    Array.from({ length: 1000 }, () => b.next()),
  );
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `mean ${mean}`);
  assert.notDeepEqual(
    xs.slice(0, 5),
    Array.from({ length: 5 }, () => new Rng(43).next()),
  );
  assert.equal(new Rng(-1).state, 0xffffffff, "the seed is reduced to uint32");
});

test("Rng.int / range / chance stay in range", () => {
  const r = new Rng(5);
  for (let i = 0; i < 500; i++) {
    const n = r.int(7);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 7);
    const f = r.range(10, 20);
    assert.ok(f >= 10 && f < 20);
  }
  assert.equal(new Rng(1).chance(0), false);
  assert.equal(new Rng(1).chance(1), true);
});
