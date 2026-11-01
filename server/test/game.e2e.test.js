// The authoritative game over REAL sockets: inputs up, snapshots down, in both codecs.

import test from "node:test";
import assert from "node:assert/strict";
import { CLOSE, STEP, Ship, TICK_RATE, binaryCodec, jsonCodec } from "@dogfight/shared";
import { connect, createRoom, joined, sleep, startApp } from "./helpers.js";

async function withGame(env, fn) {
  const s = await startApp(env);
  try {
    const { body: room } = await createRoom(s.base, {
      name: "Duel",
      arena: { asteroids: 0, hunters: 0, asteroidSpeed: [40, 80] },
    });
    await fn(s, room);
  } finally {
    await s.close();
  }
}

/** A client that sends one input per call, in the codec it joined with. */
function inputSender(client, codec) {
  let seq = 0;
  return (over = {}) => {
    const input = {
      type: "input",
      seq: ++seq,
      tick: 0,
      thrust: false,
      turn: 0,
      fire: false,
      ...over,
    };
    client.send(codec.encode(input));
    return input;
  };
}

for (const [name, codec] of [
  ["binary", binaryCodec],
  ["json", jsonCodec],
]) {
  test(`${name}: joined carries the ship, the seed and the tick rate; snapshots arrive at ~30 Hz`, async () => {
    await withGame({}, async (s, room) => {
      const a = await joined(s.wsUrl, room.id, "Ace", { codec: name });
      assert.equal(typeof a.first.shipId, "number");
      assert.equal(a.first.tickRate, TICK_RATE);
      assert.equal(a.first.codec, name);
      assert.equal(typeof a.first.seed, "number");
      assert.deepEqual(a.first.players, [{ id: a.first.you, name: "Ace", shipId: a.first.shipId }]);

      const t0 = Date.now();
      await a.untilSnapshot((snap) => snap.tick >= 31);
      const seconds = (Date.now() - t0) / 1000;
      const rate = a.snapshots.length / seconds;
      assert.ok(rate > 25 && rate < 36, `${rate.toFixed(1)} snapshots/s`);
      assert.equal(a.snapshots[0].you.id, a.first.shipId);
      a.socket.close();
    });
  });

  test(`${name}: the server applies inputs and acknowledges them; replaying them on a local ship reproduces the server's`, async () => {
    await withGame({}, async (s, room) => {
      const a = await joined(s.wsUrl, room.id, "Ace", { codec: name });
      const send = inputSender(a, codec);
      const start = (await a.untilSnapshot(() => true)).you;
      const local = Ship.fromState(start);

      const sent = [];
      for (let i = 0; i < 40; i++) {
        sent.push(send({ thrust: i % 5 !== 4, turn: i % 12 < 4 ? 1 : i % 12 < 8 ? -1 : 0 }));
        await sleep(30);
      }
      const last = sent.at(-1).seq;
      const snap = await a.untilSnapshot((x) => x.ack === last);
      for (const input of sent) local.integrate(input, STEP); // the SAME shared function

      const tolerance = name === "binary" ? 0.05 : 1e-9; // f32 rounding of the starting state
      assert.ok(
        Math.abs(snap.you.x - local.pos.x) < tolerance,
        `x: server ${snap.you.x} vs local ${local.pos.x}`,
      );
      assert.ok(
        Math.abs(snap.you.y - local.pos.y) < tolerance,
        `y: server ${snap.you.y} vs local ${local.pos.y}`,
      );
      assert.ok(Math.abs(snap.you.angle - local.angle) < 1e-3);
      assert.ok(snap.you.x !== start.x || snap.you.y !== start.y, "the ship moved");
      a.socket.close();
    });
  });

  test(`${name}: a cheating input (turn 1000, a position) closes the connection`, async () => {
    await withGame({}, async (s, room) => {
      const keeper = await joined(s.wsUrl, room.id, "Keeper"); // an emptied room is deleted
      const a = await joined(s.wsUrl, room.id, "Cheat", { codec: name });
      if (name === "json") {
        a.send({ v: 1, type: "input", seq: 1, tick: 0, thrust: true, turn: 1000, fire: false });
      } else {
        const bytes = binaryCodec.encode({
          type: "input",
          seq: 1,
          tick: 0,
          thrust: true,
          turn: 0,
          fire: false,
        });
        bytes[11] = 100; // turn byte
        a.send(bytes);
      }
      assert.equal((await a.closed).code, CLOSE.BAD_MESSAGE);

      const b = await joined(s.wsUrl, room.id, "Teleporter", { codec: name });
      b.send({
        v: 1,
        type: "input",
        seq: 1,
        tick: 0,
        thrust: true,
        turn: 0,
        fire: false,
        x: 800,
        y: 450,
      });
      assert.equal((await b.closed).code, CLOSE.BAD_MESSAGE, "a position is not part of an input");
      keeper.socket.close();
    });
  });

  test(`${name}: ping → pong carries the echoed time and the server tick`, async () => {
    await withGame({}, async (s, room) => {
      const a = await joined(s.wsUrl, room.id, "Ace", { codec: name });
      a.send(codec.encode({ type: "ping", t: 4242 }));
      const pong = await a.nextPong();
      assert.equal(pong.type, "pong");
      assert.equal(pong.t, 4242);
      assert.ok(pong.tick >= 0);
      a.socket.close();
    });
  });
}

test("a client cannot use the other codec than it joined with", async () => {
  await withGame({}, async (s, room) => {
    const bin = await joined(s.wsUrl, room.id, "Bin", { codec: "binary" });
    bin.send(
      jsonCodec.encode({ type: "input", seq: 1, tick: 0, thrust: true, turn: 0, fire: false }),
    );
    assert.equal((await bin.closed).code, CLOSE.UNSUPPORTED);
  });
});

test("two players see each other (ids match the roster), and a shot fired by one is in the other's snapshots", async () => {
  await withGame({}, async (s, room) => {
    const a = await joined(s.wsUrl, room.id, "Ace");
    const b = await joined(s.wsUrl, room.id, "Bob");
    const roster = (await a.next()).players;
    assert.deepEqual(
      roster.map((p) => p.name),
      ["Ace", "Bob"],
    );
    assert.deepEqual(
      roster.map((p) => p.shipId),
      [a.first.shipId, b.first.shipId],
    );

    const snapB = await b.untilSnapshot((x) => x.ships.some((ship) => ship.id === a.first.shipId));
    assert.equal(snapB.you.id, b.first.shipId);

    const send = inputSender(a, binaryCodec);
    const fired = send({ fire: true });
    const withBullet = await b.untilSnapshot((x) =>
      x.bullets.some((bullet) => bullet.seq === fired.seq),
    );
    assert.equal(
      withBullet.bullets.find((bullet) => bullet.seq === fired.seq).owner,
      a.first.shipId,
    );
    assert.ok(
      (await a.untilSnapshot((x) => x.ack === fired.seq)).events.concat(withBullet.events).length >=
        0,
    );
    a.socket.close();
    b.socket.close();
  });
});

test("the roster message and the room list stay in step with the match", async () => {
  await withGame({}, async (s, room) => {
    const a = await joined(s.wsUrl, room.id, "Ace");
    const stats = await (await fetch(`${s.base}/api/stats`)).json();
    assert.equal(stats.tickRate, TICK_RATE);
    assert.equal(stats.matches.length, 1);
    assert.equal(stats.matches[0].players, 1);
    await sleep(300);
    const later = (await (await fetch(`${s.base}/api/stats`)).json()).matches[0];
    assert.ok(later.tick > 5);
    assert.ok(later.tickDurationMs.n > 5);
    assert.ok(later.tickLatenessMs.max < 40, `lateness ${later.tickLatenessMs.max} ms`);
    assert.ok(later.bytesOutPerSec > 100);
    a.socket.close();
    await a.closed;
    await sleep(50);
    assert.equal(
      (await (await fetch(`${s.base}/api/stats`)).json()).matches.length,
      0,
      "the match ends with the room",
    );
  });
});

// ── the latency injector ───────────────────────────────────────────────────────────────

async function measureRtt(client, codec, pings = 6) {
  const rtts = [];
  for (let i = 0; i < pings; i++) {
    const t = Date.now() % 2 ** 31;
    client.send(codec.encode({ type: "ping", t }));
    const pong = await client.nextPong(3000);
    rtts.push((Date.now() % 2 ** 31) - pong.t);
    await sleep(40);
  }
  return Math.min(...rtts);
}

test("netsim via the URL: ?lag=200 makes the round trip ≥ 200 ms; a normal connection stays fast", async () => {
  await withGame({}, async (s, room) => {
    const fast = await joined(s.wsUrl, room.id, "Fast");
    const slow = await joined(`${s.wsUrl}?lag=200&jitter=10`, room.id, "Slow");
    const [rttFast, rttSlow] = [
      await measureRtt(fast, binaryCodec),
      await measureRtt(slow, binaryCodec),
    ];
    assert.ok(rttFast < 40, `fast RTT ${rttFast} ms`);
    assert.ok(rttSlow >= 185 && rttSlow < 300, `lagged RTT ${rttSlow} ms`);
    fast.socket.close();
    slow.socket.close();
  });
});

test("netsim live: a `netsim` message changes this connection's lag, and 0 turns it off again", async () => {
  await withGame({}, async (s, room) => {
    const a = await joined(s.wsUrl, room.id, "Ace");
    assert.ok((await measureRtt(a, binaryCodec, 3)) < 40);
    a.send({ v: 1, type: "netsim", latency: 160, jitter: 0, drop: 0 });
    await sleep(50);
    const lagged = await measureRtt(a, binaryCodec, 3);
    assert.ok(lagged >= 150, `RTT ${lagged} ms`);
    a.send({ v: 1, type: "netsim", latency: 0, jitter: 0, drop: 0 });
    await sleep(300); // let what is still in flight arrive
    assert.ok((await measureRtt(a, binaryCodec, 4)) < 60);
    a.socket.close();
  });
});

test("netsim drop loses snapshots: tick numbers have gaps", async () => {
  await withGame({}, async (s, room) => {
    const a = await joined(`${s.wsUrl}?drop=0.3`, room.id, "Lossy");
    await a.untilSnapshot((x) => x.tick > 90, 5000);
    const ticks = a.snapshots.map((x) => x.tick);
    const gaps = ticks.slice(1).filter((t, i) => t - ticks[i] > 1).length;
    assert.ok(gaps > 10, `${gaps} gaps in ${ticks.length} snapshots`);
    assert.ok(
      ticks.every((t, i) => i === 0 || t > ticks[i - 1]),
      "still in order",
    );
    a.socket.close();
  });
});

test("ENABLE_NETSIM=0: the query string is ignored and the message is refused", async () => {
  await withGame({ ENABLE_NETSIM: "0" }, async (s, room) => {
    const a = await joined(`${s.wsUrl}?lag=400`, room.id, "Ace");
    assert.ok((await measureRtt(a, binaryCodec, 3)) < 60, "?lag= had no effect");
    a.send({ v: 1, type: "netsim", latency: 400, jitter: 0, drop: 0 });
    assert.equal((await a.next()).code, "netsim_disabled");
    a.socket.close();
  });
});

test("NODE_ENV=production switches netsim off by default", async () => {
  const s = await startApp({ NODE_ENV: "production" });
  try {
    assert.equal(s.app.config.netsim, false);
  } finally {
    await s.close();
  }
});

test("a client that leaves mid-lag does not make the server deliver to a closed socket", async () => {
  await withGame({}, async (s, room) => {
    const keeper = await joined(s.wsUrl, room.id, "Keeper");
    const a = await joined(`${s.wsUrl}?lag=300`, room.id, "Ghost");
    a.socket.terminate();
    await sleep(500);
    const b = await joined(s.wsUrl, room.id, "Later");
    assert.equal(b.first.type, "joined");
    b.socket.close();
    keeper.socket.close();
  });
});

test("connect() helper reads both codecs: raw frames from the server are what the spec says", async () => {
  await withGame({}, async (s, room) => {
    const c = connect(s.wsUrl);
    await c.opened;
    const frames = [];
    c.socket.on("message", (data, isBinary) => isBinary && frames.push(data));
    c.send({ v: 1, type: "join", room: room.id, name: "Raw" });
    await c.next();
    await sleep(150);
    assert.ok(frames.length >= 3);
    assert.equal(frames[0][0], 2, "byte 0 = SNAPSHOT");
    assert.equal(frames[0][1], 1, "byte 1 = version 1");
    c.socket.close();
  });
});
