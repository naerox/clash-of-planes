import test from "node:test";
import assert from "node:assert/strict";
import { ARENA, STEP_MS } from "@dogfight/shared";
import { bulletSnap, shipSnap as ship, snap } from "../testing.ts";
import { SnapshotBuffer, interpolateRemote } from "./snapshotBuffer.ts";

test("push accepts newer ticks and discards late or duplicate ones", () => {
  const buf = new SnapshotBuffer();
  assert.equal(buf.push(snap(10), 0), true);
  assert.equal(buf.push(snap(11), 33), true);
  assert.equal(buf.push(snap(11), 40), false, "duplicate");
  assert.equal(buf.push(snap(9), 41), false, "older than the newest: arrived out of order");
  assert.equal(buf.size, 2);
  assert.equal(buf.discarded, 2);
  assert.equal(buf.latest?.tick, 11);
});

test("gaps in the tick numbers are counted as lost snapshots", () => {
  const buf = new SnapshotBuffer();
  buf.push(snap(1), 0);
  buf.push(snap(2), 33);
  buf.push(snap(5), 133); // 3 and 4 never arrived
  assert.equal(buf.gaps, 2);
});

test("the buffer is bounded", () => {
  const buf = new SnapshotBuffer({ capacity: 10 });
  for (let t = 1; t <= 50; t++) buf.push(snap(t), t * STEP_MS);
  assert.equal(buf.size, 10);
  assert.equal(buf.latest?.tick, 50);
});

test("clock offset = the FASTEST packet in the window (jitter makes later ones look late, not the clock wrong)", () => {
  const buf = new SnapshotBuffer();
  const delays = [40, 70, 55, 40, 95, 62];
  delays.forEach((d, i) => buf.push(snap(i + 1), (i + 1) * STEP_MS + d));
  assert.ok(Math.abs(buf.offsetMs - 40) < 1e-9);
  // render time: "now" minus the delay, expressed in ticks of the server's clock
  const now = 10 * STEP_MS + 40;
  assert.ok(Math.abs(buf.renderTick(now, 100) - (10 - 100 / STEP_MS)) < 1e-9);
});

test("the offset follows clock drift: old, faster samples age out of the window", () => {
  const buf = new SnapshotBuffer({ offsetWindow: 5 });
  for (let t = 1; t <= 5; t++) buf.push(snap(t), t * STEP_MS + 10);
  assert.equal(Math.round(buf.offsetMs), 10);
  for (let t = 6; t <= 12; t++) buf.push(snap(t), t * STEP_MS + 60); // the link got slower
  assert.equal(Math.round(buf.offsetMs), 60);
});

test("sample() brackets the render tick and reports the position between the two", () => {
  const buf = new SnapshotBuffer();
  for (const t of [10, 11, 12, 14]) buf.push(snap(t), t * STEP_MS);
  const mid = buf.sample(11.5);
  assert.ok(mid);
  assert.deepEqual([mid.a.tick, mid.b?.tick], [11, 12]);
  assert.equal(mid.t, 0.5);
  const gap = buf.sample(13); // 13 never arrived: interpolate across the gap
  assert.ok(gap);
  assert.deepEqual([gap.a.tick, gap.b?.tick], [12, 14]);
  assert.equal(gap.t, 0.5);
  assert.equal(gap.starved, false);
});

test("beyond the newest snapshot the last state is HELD (starved), never extrapolated", () => {
  const buf = new SnapshotBuffer();
  buf.push(snap(10), 0);
  buf.push(snap(11), 33);
  const s = buf.sample(11.6);
  assert.ok(s);
  assert.equal(s.starved, true);
  assert.equal(s.a.tick, 11);
  assert.equal(s.b, null);
});

test("before the oldest snapshot we clamp to it; with nothing at all, sample() is null", () => {
  const buf = new SnapshotBuffer();
  assert.equal(buf.sample(5), null);
  buf.push(snap(10), 0);
  buf.push(snap(11), 33);
  const early = buf.sample(2);
  assert.ok(early);
  assert.equal(early.a.tick, 10);
  assert.equal(early.starved, false);
});

// ── interpolating the lists ───────────────────────────────────────────────────────────

test("a ship halfway between two snapshots is drawn halfway", () => {
  const a = snap(1, { ships: [ship(7, 100, 100, 0)] });
  const b = snap(2, { ships: [ship(7, 110, 120, 1)] });
  const [s] = interpolateRemote({ a, b, t: 0.5 }).ships;
  assert.deepEqual([s?.x, s?.y, s?.angle], [105, 110, 0.5]);
});

test("ships take the SHORT way round the arena edge and round ±π", () => {
  const a = snap(1, { ships: [ship(1, ARENA.width - 4, 50, 3.1)] });
  const b = snap(2, { ships: [ship(1, 6, 50, -3.1)] });
  const s = interpolateRemote({ a, b, t: 0.5 }).ships[0];
  assert.ok(s);
  assert.ok(s.x > ARENA.width - 3 || s.x < 3, `crossed the edge, x = ${s.x}`);
  assert.ok(Math.abs(Math.abs(s.angle) - Math.PI) < 0.1, `short way round: ${s.angle}`);
});

test("bullets and asteroids do NOT wrap (a bullet leaving the arena just keeps going)", () => {
  const a = snap(1, { bullets: [bulletSnap(1, 2, ARENA.width - 4, 5)] });
  const b = snap(2, { bullets: [bulletSnap(1, 2, ARENA.width + 20, 5)] });
  assert.equal(interpolateRemote({ a, b, t: 0.5 }).bullets[0]?.x, ARENA.width + 8);
});

test("an entity that appears between snapshots is not drawn until the render time reaches it", () => {
  const a = snap(1);
  const b = snap(2, { bullets: [bulletSnap(9, 1, 5, 5)] });
  assert.deepEqual(interpolateRemote({ a, b, t: 0.9 }).bullets, []);
  const next = snap(3, { bullets: [bulletSnap(9, 1, 12, 5)] });
  assert.equal(interpolateRemote({ a: b, b: next, t: 0 }).bullets.length, 1);
});

test("an entity that disappears is held at its last position until the render time passes it", () => {
  const a = snap(1, { bullets: [bulletSnap(9, 1, 40, 5)] });
  const b = snap(2);
  const bullets = interpolateRemote({ a, b, t: 0.7 }).bullets;
  assert.deepEqual(
    bullets.map((x) => x.x),
    [40],
  );
  assert.deepEqual(interpolateRemote({ a: b, b: snap(3), t: 0 }).bullets, []);
});

test("a respawn teleport is not drawn as a streak across the arena", () => {
  const a = snap(1, { ships: [ship(1, 100, 100)] });
  const b = snap(2, { ships: [ship(1, 1200, 700)] });
  const early = interpolateRemote({ a, b, t: 0.3 }).ships[0];
  const late = interpolateRemote({ a, b, t: 0.7 }).ships[0];
  assert.equal(early?.x, 100);
  assert.equal(late?.x, 1200);
});

test("when several snapshots were lost, the allowed distance grows with the gap", () => {
  const a = snap(10, { ships: [ship(1, 100, 100)] });
  const b = snap(16, { ships: [ship(1, 300, 100)] }); // 200 units in 6 ticks (200 ms): a fast ship
  assert.equal(interpolateRemote({ a, b, t: 0.5 }).ships[0]?.x, 200);
});

test("with no newer snapshot (starved) the older one is returned as is", () => {
  const a = snap(1, { ships: [ship(1, 5, 5)] });
  assert.deepEqual(interpolateRemote({ a, b: null, t: 0 }).ships, a.ships);
});
