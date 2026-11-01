import test from "node:test";
import assert from "node:assert/strict";
import { TokenBucket } from "../src/rateLimit.js";

test("a burst up to capacity passes, then the bucket is empty", () => {
  const t = 0;
  const b = new TokenBucket({ capacity: 5, perSec: 10, now: () => t });
  for (let i = 0; i < 5; i++) assert.equal(b.take(), true);
  assert.equal(b.take(), false);
});

test("tokens refill with time, up to capacity", () => {
  let t = 0;
  const b = new TokenBucket({ capacity: 5, perSec: 10, now: () => t });
  for (let i = 0; i < 5; i++) b.take();
  t = 100; // +1 token
  assert.equal(b.take(), true);
  assert.equal(b.take(), false);
  t = 60_000; // a long pause does not bank more than `capacity`
  for (let i = 0; i < 5; i++) assert.equal(b.take(), true);
  assert.equal(b.take(), false);
});

test("a sustained rate at the limit never trips", () => {
  let t = 0;
  const b = new TokenBucket({ capacity: 2, perSec: 10, now: () => t });
  for (let i = 0; i < 100; i++) {
    t += 100; // exactly 10/s
    assert.equal(b.take(), true);
  }
});
