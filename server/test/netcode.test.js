// Prediction, reconciliation and interpolation measured end to end: the real Match, the real
// client GameSession, a virtual network. See harness.js.

import test from "node:test";
import assert from "node:assert/strict";
import { ARENA, Asteroid, Vector2, wrappedDelta } from "@dogfight/shared";
import { createSimulation, cruise, idle, summarize, weave, weaveAndShoot } from "./harness.js";

/** correction sizes recorded by client `i`, after the first second (warm-up) */
const corrections = (sim, i = 0) => sim.sessions[i].session.stats.corrections.values;

test("M1: with prediction OFF the ship answers one round trip late; with it ON, at the next frame", () => {
  const response = (predict) => {
    const sim = createSimulation({ rttMs: 100, options: { predict } });
    const press = 2000;
    sim.run(press, idle);
    const start = sim.sessions[0].renders.at(-1).scene.me;
    let movedAt = null;
    sim.run(600, (_i, t) => (t >= press ? cruise() : idle()), {
      onMs: (t) => {
        const me = sim.sessions[0].renders.at(-1)?.scene.me;
        if (movedAt === null && t > press && me && Math.hypot(me.x - start.x, me.y - start.y) > 0.5)
          movedAt = t;
      },
    });
    return movedAt - press;
  };
  const dumb = response(false);
  const predicted = response(true);
  // a ship at rest needs two 30 Hz steps (67 ms) just to travel half a unit: acceleration is
  // gradual. Prediction pays only that; without it the same motion shows up only after the
  // input has made the whole round trip.
  assert.ok(predicted <= 80, `with prediction: ${predicted} ms`);
  assert.ok(dumb >= 100, `without prediction: ${dumb} ms (RTT is 100 ms)`);
  assert.ok(dumb >= predicted + 70, `${dumb} ms without vs ${predicted} ms with`);
});

test("M2: in open space the prediction is right — corrections stay at floating-point noise", () => {
  for (const rttMs of [0, 100, 250]) {
    const sim = createSimulation({ rttMs });
    sim.run(6000, weave);
    const c = summarize(corrections(sim).slice(30));
    assert.ok(c.n > 100);
    assert.ok(c.max < 0.01, `rtt ${rttMs}: max correction ${c.max}`);
  }
});

test("the client ship and the server ship agree: after the last ack, replay lands on the server's state", () => {
  const sim = createSimulation({ rttMs: 100, jitterMs: 20, options: {} });
  sim.run(5000, weave);
  const { session } = sim.sessions[0];
  const server = sim.match.world.get(sim.sessions[0].peer.player.shipId);
  // the server has applied every input that reached it; the client's pending ones are in flight
  const predicted = session.predictor.ship;
  assert.ok(session.predictor.pending.length >= 2, "inputs are in flight");
  const err = Math.hypot(
    wrappedDelta(server.pos.x, predicted.pos.x, ARENA.width),
    wrappedDelta(server.pos.y, predicted.pos.y, ARENA.height),
  );
  assert.ok(
    err < 100,
    `the predicted ship is ahead of the server by about the in-flight distance (${err.toFixed(1)})`,
  );
});

test("M2: breaking determinism on purpose (noise in the predicted step) makes the corrections GROW", () => {
  const meanCorrection = (chaos) => {
    const sim = createSimulation({ rttMs: 100, options: { chaos } });
    sim.run(6000, weave);
    return summarize(corrections(sim).slice(30)).mean;
  };
  const clean = meanCorrection(0);
  const small = meanCorrection(0.002);
  const big = meanCorrection(0.01);
  assert.ok(clean < 0.001, `deterministic: ${clean}`);
  assert.ok(small > 0.005 && small > clean * 10, `noise 0.2%: ${small}`);
  assert.ok(big > small * 2, `noise 1%: ${big} vs ${small}`);
});

test("corrections scale with the round trip when determinism is broken (more inputs to replay = more noise)", () => {
  const mean = (rttMs) => {
    const sim = createSimulation({ rttMs, options: { chaos: 0.005 } });
    sim.run(6000, weave);
    return summarize(corrections(sim).slice(30)).mean;
  };
  assert.ok(mean(250) > mean(50));
});

test("a collision the client cannot predict (an asteroid) shows up as a correction spike, then settles", () => {
  const sim = createSimulation({ rttMs: 100 });
  sim.run(1500, cruise);
  const { session, peer } = sim.sessions[0];
  const ship = sim.match.world.get(peer.player.shipId);
  // drop an asteroid on the ship's path, ahead of it: the client does not know about it
  const ahead = ship.pos.add(Vector2.fromAngle(ship.angle, 150));
  const rock = sim.match.world.spawn(
    new Asteroid(ahead, Vector2.fromAngle(ship.angle + Math.PI, 60), 30),
  );
  const before = summarize(corrections(sim).slice(-20));
  sim.run(1500, cruise);
  const during = summarize(corrections(sim).slice(-45));
  assert.ok(before.max < 0.01);
  assert.ok(during.max > 5, `collision → correction ${during.max}`);
  rock.alive = false;
  // knocked back by 25 damage per tick of contact: the server said "not there", the client agrees
  sim.run(3000, idle);
  const after = summarize(corrections(sim).slice(-20));
  assert.ok(after.max < 0.01, `settled again (${after.max})`);
  assert.equal(session.predictor.pending.length < 10, true);
});

test("the correction is SMOOTHED: a 20-unit shove from the server is not drawn as a 20-unit jump", () => {
  // "jerk" = the second difference of the drawn position: 0 for straight motion, large for a
  // sudden shove. The server moves our ship by 20 units mid-flight (something the client cannot
  // have predicted); we look at what the PLAYER sees.
  const jerk = (smoothMs) => {
    const sim = createSimulation({ rttMs: 100, options: { smoothMs } });
    sim.run(2000, cruise);
    const ship = sim.match.world.get(sim.sessions[0].peer.player.shipId);
    ship.pos = ship.pos.add({ x: 0, y: 20 });
    sim.run(1000, cruise);
    const p = sim.sessions[0].renders.slice(100).map((r) => r.scene.me);
    let worst = 0;
    for (let i = 1; i < p.length - 1; i++) {
      const d1 = [
        wrappedDelta(p[i - 1].x, p[i].x, ARENA.width),
        wrappedDelta(p[i - 1].y, p[i].y, ARENA.height),
      ];
      const d2 = [
        wrappedDelta(p[i].x, p[i + 1].x, ARENA.width),
        wrappedDelta(p[i].y, p[i + 1].y, ARENA.height),
      ];
      worst = Math.max(worst, Math.hypot(d2[0] - d1[0], d2[1] - d1[1]));
    }
    return worst;
  };
  const smooth = jerk(100);
  const snapped = jerk(0);
  assert.ok(
    snapped > 15,
    `without smoothing the shove is visible in full: ${snapped.toFixed(1)} units`,
  );
  assert.ok(smooth < snapped / 4, `smoothed: ${smooth.toFixed(2)} units`);
});

test("reconciliation OFF: the prediction drifts away from the server and nothing pulls it back", () => {
  const drift = (reconcile) => {
    const sim = createSimulation({ rttMs: 100, options: { reconcile, chaos: 0.01 } });
    sim.run(8000, weave);
    const server = sim.match.world.get(sim.sessions[0].peer.player.shipId);
    const predicted = sim.sessions[0].session.predictor.ship;
    return Math.hypot(
      wrappedDelta(server.pos.x, predicted.pos.x, ARENA.width),
      wrappedDelta(server.pos.y, predicted.pos.y, ARENA.height),
    );
  };
  assert.ok(
    drift(false) > drift(true) * 2,
    `no reconcile ${drift(false).toFixed(1)} vs reconcile ${drift(true).toFixed(1)}`,
  );
});

test("the server never trusts the client's ship: a client that predicts nonsense is still where the server says", () => {
  const sim = createSimulation({ rttMs: 60, options: { chaos: 0.3 } });
  sim.run(4000, cruise);
  const { session, peer } = sim.sessions[0];
  const server = sim.match.world.get(peer.player.shipId);
  assert.ok(
    server.vel.length() <= server.params.maxSpeed + 1e-9,
    "the server's ship obeys the real physics",
  );
  const shown = sim.sessions[0].renders.at(-1).scene.me;
  const err = Math.hypot(
    wrappedDelta(server.pos.x, shown.x, ARENA.width),
    wrappedDelta(server.pos.y, shown.y, ARENA.height),
  );
  assert.ok(err < 150, `the drawn ship stays near the authoritative one (${err.toFixed(0)})`);
  assert.ok(
    session.stats.report().correctionMean > 1,
    "…and the corrections show how wrong the client was",
  );
});

test("lost packets: inputs and snapshots go missing, the ship still converges (2% loss, 100 ms ± 30)", () => {
  const sim = createSimulation({ rttMs: 100, jitterMs: 30, loss: 0.02 });
  sim.run(15000, weave);
  const { session } = sim.sessions[0];
  const report = session.stats.report();
  assert.ok(report.lostSnapshots > 5, `${report.lostSnapshots} snapshots lost`);
  const c = summarize(corrections(sim).slice(30));
  assert.ok(c.mean < 3, `mean correction ${c.mean.toFixed(3)}`);
  // a lost INPUT means the server never applied it: the client is corrected by about one step of motion
  assert.ok(c.max < 40, `max correction ${c.max.toFixed(2)}`);
});

test("M3: our own bullet appears the same step we fire it, and the server's copy is recognised by seq", () => {
  const sim = createSimulation({ rttMs: 100 });
  sim.run(1000, idle);
  const { session, events } = sim.sessions[0];
  assert.equal(session.predictor.bullets.length, 0);
  sim.run(40, () => ({ thrust: false, turn: 0, fire: true })); // ~1 step
  assert.equal(session.predictor.bullets.length, 1, "predicted at once");
  assert.equal(
    events.filter((e) => e.type === "fired").length,
    1,
    "…and announced at once (sound!)",
  );
  const predicted = session.predictor.bullets[0];
  assert.ok(predicted.id < 0, "a local id until the server confirms");
  sim.run(300, idle);
  const confirmed = session.predictor.bullets.find((b) => b.seq === predicted.seq);
  assert.ok(confirmed?.confirmed, "the server's bullet with the same seq was recognised");
  assert.ok(confirmed.id > 0, "and its id adopted");
  assert.equal(
    events.filter((e) => e.type === "fired").length,
    1,
    "the server's echo of our own shot does not double the sound",
  );
});

test("our own bullets are drawn from prediction; other players' bullets from interpolation", () => {
  const sim = createSimulation({
    rttMs: 100,
    clients: 2,
    arena: { asteroids: 0, hunters: 0, asteroidSpeed: [1, 2] },
  });
  sim.run(3000, (i, t) => (i === 0 ? weaveAndShoot(i, t) : idle()));
  const mine = sim.sessions[0].renders.at(-1).scene;
  const theirs = sim.sessions[1].renders.at(-1).scene;
  const shipA = sim.sessions[0].peer.player.shipId;
  assert.ok(mine.bullets.every((b) => b.owner === shipA));
  assert.ok(mine.bullets.length >= 2);
  assert.ok(theirs.bullets.length >= 1, "player B sees A's bullets (from snapshots)");
  assert.ok(theirs.bullets.every((b) => b.owner === shipA));
});

test("a predicted bullet that hits something on the server is removed when the server stops reporting it", () => {
  const sim = createSimulation({ rttMs: 60, clients: 2 });
  const [a, b] = sim.sessions.map((s) => sim.match.world.get(s.peer.player.shipId));
  a.angle = 0;
  b.pos = a.pos.add({ x: 90, y: 0 });
  sim.run(1500, (i) => (i === 0 ? { thrust: false, turn: 0, fire: true } : idle()));
  const stats = sim.sessions[0].session;
  assert.ok(b.hp < 100 || b.isDead, "B was hit");
  assert.ok(
    stats.predictor.bullets.length <= 4,
    `no ghost bullets accumulate (${stats.predictor.bullets.length})`,
  );
});

/** How another player's ship looks on OUR screen: the largest frame-to-frame step, and the share of frames where it did not move. */
function watchRemote({ inputReserve, interpMs = 100 }) {
  const sim = createSimulation({
    rttMs: 100,
    jitterMs: 30,
    loss: 0.02,
    clients: 2,
    inputReserve,
    options: { interpMs },
  });
  sim.run(15000, (i, t) => (i === 1 ? weave(i, t) : idle()));
  const shipB = sim.sessions[1].peer.player.shipId;
  const track = sim.sessions[0].renders
    .slice(120)
    .map((r) => r.scene.ships.find((s) => s.id === shipB))
    .filter(Boolean);
  let worst = 0;
  let stalls = 0;
  for (let i = 1; i < track.length; i++) {
    const step = Math.hypot(
      wrappedDelta(track[i - 1].x, track[i].x, ARENA.width),
      wrappedDelta(track[i - 1].y, track[i].y, ARENA.height),
    );
    worst = Math.max(worst, step);
    if (step === 0) stalls++;
  }
  return { worst, frozen: stalls / track.length, frames: track.length };
}

test("M3: another player's ship is drawn smoothly (no teleports) at 100 ms ± 30 ms with 2% loss", () => {
  const seen = watchRemote({ inputReserve: 1 });
  assert.ok(seen.frames > 700, `B visible in ${seen.frames} frames`);
  // a ship at 420 u/s moves 7 units per 16.7 ms frame; interpolation across a lost snapshot may
  // briefly speed up or pause, but never jump
  assert.ok(seen.worst < 20, `largest frame-to-frame step ${seen.worst.toFixed(1)} units`);
  assert.ok(seen.frozen < 0.05, `${(seen.frozen * 100).toFixed(1)}% of frames frozen`);
});

test("the server's input reserve (a jitter buffer) removes the lurching other players see", () => {
  const without = watchRemote({ inputReserve: 0 });
  const withReserve = watchRemote({ inputReserve: 1 });
  assert.ok(
    without.frozen > 0.08,
    `no reserve: ${(without.frozen * 100).toFixed(1)}% frozen frames`,
  );
  assert.ok(
    withReserve.frozen < without.frozen / 3,
    `reserve 1: ${(withReserve.frozen * 100).toFixed(1)}%`,
  );
});

test("M3: the interpolation delay is a trade-off — too short and the buffer runs dry (starvation)", () => {
  const starved = (interpMs) => {
    const sim = createSimulation({
      rttMs: 100,
      jitterMs: 30,
      loss: 0.02,
      clients: 2,
      options: { interpMs },
    });
    sim.run(20000, (i, t) => (i === 1 ? weave(i, t) : idle()));
    return sim.sessions[0].session.stats.report().starvedPercent;
  };
  const [d16, d66, d100, d150] = [16, 66, 100, 150].map(starved);
  assert.ok(d16 > 20, `16 ms: ${d16.toFixed(1)}% of frames starved`);
  assert.ok(d16 > d66 && d66 > d100, `${d16.toFixed(1)} > ${d66.toFixed(1)} > ${d100.toFixed(1)}`);
  assert.ok(d100 < 2, `100 ms: ${d100.toFixed(2)}%`);
  assert.ok(d150 <= d100 + 0.01);
});

test("entities appear and disappear between snapshots without errors (a bullet is born and dies)", () => {
  const sim = createSimulation({ rttMs: 100, jitterMs: 30, loss: 0.05, clients: 2 });
  assert.doesNotThrow(() =>
    sim.run(10000, (i, t) => (i === 0 ? weaveAndShoot(i, t) : weave(i, t))),
  );
  const frames = sim.sessions[1].renders;
  const counts = new Set(frames.map((f) => f.scene.bullets.length));
  assert.ok(counts.size > 1, "the number of visible bullets changes over time");
});

test("the JSON codec carries the same game, just in more bytes", () => {
  const run = (codec) => {
    const sim = createSimulation({ rttMs: 100, codec, clients: 2 });
    sim.run(5000, weave);
    const r = sim.sessions[0].session.stats.report();
    return {
      down: r.downBytesPerSec,
      up: r.upBytesPerSec,
      corr: summarize(corrections(sim).slice(30)).max, // after the start-up transient
      snap: r.avgSnapshotBytes,
    };
  };
  const bin = run("binary");
  const json = run("json");
  assert.ok(
    bin.corr < 0.01 && json.corr < 0.01,
    `both predict exactly (${bin.corr}, ${json.corr})`,
  );
  assert.ok(
    json.down > bin.down * 3,
    `down: json ${json.down.toFixed(0)} B/s vs binary ${bin.down.toFixed(0)} B/s`,
  );
  assert.ok(json.up > bin.up * 4, `up: json ${json.up.toFixed(0)} vs binary ${bin.up.toFixed(0)}`);
});

test("RTT is measured from ping/pong: the netgraph's RTT matches the virtual network's", () => {
  const sim = createSimulation({ rttMs: 140, jitterMs: 0 });
  sim.run(3000, idle);
  const r = sim.sessions[0].session.stats.report();
  assert.ok(Math.abs(r.rttMs - 140) <= 3, `RTT ${r.rttMs}`);
  assert.ok(r.snapshotAgeMs >= 0 && r.snapshotAgeMs < 40);
  assert.ok(r.pendingInputs >= 3, `inputs in flight at 140 ms: ${r.pendingInputs}`);
});

test("rejoining after a reconnect throws the old prediction away (it belongs to a ship that no longer exists)", () => {
  const sim = createSimulation({ rttMs: 60 });
  sim.run(2000, cruise);
  const { session } = sim.sessions[0];
  const seqBefore = session.seq;
  session.rejoin({ shipId: 999, you: "p-new", players: [], codec: "binary", tick: 0 });
  assert.equal(session.predictor, null);
  assert.equal(session.shipId, 999);
  assert.equal(
    session.seq,
    seqBefore,
    "the input counter keeps counting: the server only accepts seq above what it has seen",
  );
});
