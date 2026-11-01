import test from "node:test";
import assert from "node:assert/strict";
import { NetStats } from "./netstats.js";

function fakeClock() {
  const clock = { t: 0 };
  return { clock, now: () => clock.t };
}

test("bytes per second is a sliding one-second window", () => {
  const { clock, now } = fakeClock();
  const s = new NetStats({ now });
  for (let i = 0; i < 30; i++) {
    clock.t = i * 33;
    s.onFrame(100);
    s.onSend(12);
  }
  clock.t = 990;
  assert.ok(Math.abs(s.report().downBytesPerSec - 3000) < 110);
  assert.ok(Math.abs(s.report().upBytesPerSec - 360) < 15);
  clock.t = 5000; // nothing arrived for 4 s
  assert.equal(s.report().downBytesPerSec, 0);
});

test("snapshot age grows until the next one arrives; intervals and lost ticks are tracked", () => {
  const { clock, now } = fakeClock();
  const s = new NetStats({ now });
  assert.equal(s.report().snapshotAgeMs, Infinity);
  clock.t = 100;
  s.onSnapshot({ tick: 1 }, 80);
  clock.t = 133;
  s.onSnapshot({ tick: 2 }, 80);
  clock.t = 233;
  s.onSnapshot({ tick: 5 }, 80); // ticks 3 and 4 were lost
  clock.t = 253;
  const r = s.report();
  assert.equal(r.snapshotAgeMs, 20);
  assert.equal(r.lostSnapshots, 2);
  assert.equal(r.snapshots, 3);
  assert.ok(Math.abs(r.lossPercent - 40) < 1e-9, "2 lost of 5 expected");
  assert.equal(r.snapshotIntervalMaxMs, 100);
  assert.equal(r.avgSnapshotBytes, 80);
});

test("RTT: last, mean and jitter (the spread) of the pongs", () => {
  const s = new NetStats({ now: () => 0 });
  for (const rtt of [100, 110, 90, 100]) s.onPong(rtt);
  const r = s.report();
  assert.equal(r.rttMs, 100);
  assert.equal(r.rttMeanMs, 100);
  assert.ok(r.rttJitterMs > 5 && r.rttJitterMs < 10);
});

test("corrections: last, mean and the worst of the recent ones", () => {
  const s = new NetStats({ now: () => 0 });
  [0, 0, 5, 0, 1].forEach((c) => s.onCorrection(c));
  const r = s.report();
  assert.equal(r.correction, 1);
  assert.equal(r.correctionMax, 5);
  assert.equal(r.correctionMean, 1.2);
});

test("starvation is the share of rendered frames that had no newer snapshot to interpolate toward", () => {
  const s = new NetStats({ now: () => 0 });
  for (let i = 0; i < 100; i++) s.onRender(i < 5);
  assert.equal(s.report().starvedFrames, 5);
  assert.equal(s.report().starvedPercent, 5);
});
