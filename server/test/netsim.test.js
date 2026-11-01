import test from "node:test";
import assert from "node:assert/strict";
import { Link, NetSim } from "../src/netsim.js";

/** A link on a fake clock; `run(ms)` advances time and fires due timers. */
function fakeLink({ random = () => 0.5 } = {}) {
  let t = 0;
  const timers = [];
  const link = new Link({
    random,
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { fn, at: t + ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => (timer.cleared = true),
  });
  const run = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((x) => !x.cleared && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at;
      due.cleared = true;
      due.fn();
    }
    t = end;
  };
  return { link, run, now: () => t };
}

test("inactive link delivers synchronously and in order", () => {
  const { link } = fakeLink();
  const out = [];
  link.send(() => out.push(1));
  link.send(() => out.push(2));
  assert.deepEqual(out, [1, 2]);
  assert.equal(link.active, false);
});

test("latency delays delivery by exactly that long", () => {
  const { link, run } = fakeLink();
  link.configure({ latency: 50 });
  const out = [];
  link.send(() => out.push("a"));
  assert.deepEqual(out, []);
  run(49);
  assert.deepEqual(out, []);
  run(1);
  assert.deepEqual(out, ["a"]);
});

test("jitter varies the delay around the latency (±jitter)", () => {
  for (const [r, expected] of [
    [0, 70],
    [0.5, 100],
    [1, 130],
  ]) {
    const { link, run, now } = fakeLink({ random: () => r });
    link.configure({ latency: 100, jitter: 30 });
    let at = null;
    link.send(() => (at = now()));
    run(200);
    assert.equal(at, expected, `random()=${r}`);
  }
});

test("order is preserved even when a later message draws a shorter delay (TCP head-of-line blocking)", () => {
  const draws = [1, 0]; // first message: the slowest delay, second: the fastest
  const { link, run } = fakeLink({ random: () => draws.shift() ?? 0.5 });
  link.configure({ latency: 100, jitter: 50 });
  const out = [];
  link.send(() => out.push("first")); // 150 ms
  link.send(() => out.push("second")); // would be 50 ms, held back behind the first
  run(60);
  assert.deepEqual(out, [], "the second does not overtake the first");
  run(100);
  assert.deepEqual(out, ["first", "second"]);
});

test("drop loses messages at the configured rate and counts them", () => {
  let i = 0;
  const { link, run } = fakeLink({ random: () => (i++ % 10) / 10 }); // 0, .1, … .9
  link.configure({ drop: 0.2 });
  const out = [];
  for (let n = 0; n < 10; n++) link.send(() => out.push(n));
  run(10);
  assert.equal(link.dropped, 2, "the draws 0.0 and 0.1 are below 0.2");
  assert.equal(out.length, 8);
});

test("switching the simulation off does not let new messages overtake ones still in flight", () => {
  const { link, run } = fakeLink();
  link.configure({ latency: 100 });
  const out = [];
  link.send(() => out.push("old"));
  link.configure({ latency: 0 });
  link.send(() => out.push("new"));
  assert.deepEqual(out, [], "still queued behind the delayed one");
  run(100);
  assert.deepEqual(out, ["old", "new"]);
});

test("cancel() forgets everything in flight", () => {
  const { link, run } = fakeLink();
  link.configure({ latency: 100 });
  const out = [];
  link.send(() => out.push(1));
  link.cancel();
  run(500);
  assert.deepEqual(out, []);
  assert.equal(link.active, true, "settings stay; only the queue is gone");
});

test("NetSim: `latency` is a ROUND TRIP — each direction gets half of it", () => {
  const sim = new NetSim();
  sim.configure({ latency: 100, jitter: 20, drop: 0.05 });
  assert.equal(sim.in.latency, 50);
  assert.equal(sim.out.latency, 50);
  assert.equal(sim.in.jitter, 20);
  assert.equal(sim.out.drop, 0.05);
  assert.deepEqual(sim.settings, { latency: 100, jitter: 20, drop: 0.05 });
  sim.configure({ latency: 0, jitter: 0, drop: 0 });
  assert.equal(sim.in.active, false);
});
