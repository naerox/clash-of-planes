// Lab 8, M2: things that go wrong in production, done on purpose, against the real server.
//
//   1. a client disappears in the middle of a match (no goodbye, TCP just stops)
//   2. the SERVER goes away in the middle of a match — and either comes back empty or does not
//   3. a client sends garbage as fast as it can — it is cut off, and other rooms do not notice
import { test } from "vitest";
import assert from "node:assert/strict";
import { once } from "../../client/src/async.ts";
import type { Bus } from "../../client/src/events.ts";
import { Connection } from "../../client/src/net/connection.ts";
import { watchForLoss } from "../../client/src/net/lobbyReturn.ts";
import { msg } from "../../client/src/net/protocol.ts";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/index.ts";
import { silentLogger } from "../src/logger.ts";
import { connect, joined, openRoom, sleep, startApp } from "./helpers.ts";

const waitFor = <E, K extends keyof E>(target: Bus<E>, type: K, ms = 5000): Promise<E[K]> =>
  once(target, type, { signal: AbortSignal.timeout(ms) });

/** Largest gap, in ms, between consecutive messages that arrived on `socket` after this call. */
function watchGaps(socket: { on(e: "message", l: () => void): unknown }) {
  let last = performance.now();
  let max = 0;
  let n = 0;
  socket.on("message", () => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
    n++;
  });
  return {
    get maxGapMs() {
      return max;
    },
    get messages() {
      return n;
    },
  };
}

test("1. a client vanishes mid-match: the others are told, and the match goes on ticking", async () => {
  const s = await startApp();
  try {
    const room = await openRoom(s.base);
    const stay = await joined(s.wsUrl, room.id, "Stays");
    const gone = await joined(s.wsUrl, room.id, "Vanishes");
    await stay.nextOf("roster"); // the newcomer's arrival
    const before = stay.snapshots.length;

    gone.socket.terminate(); // no close frame: a pulled cable, a dead phone
    const roster = await stay.nextOf("roster");
    assert.deepEqual(
      roster.players.map((p) => p.name),
      ["Stays"],
    );
    await sleep(300);
    assert.ok(stay.snapshots.length > before + 5, "snapshots kept coming for the one who stayed");
    assert.equal(s.app.rooms.list()[0]?.size, 1);
    stay.socket.close();
  } finally {
    await s.close();
  }
});

test("2a. the server dies and comes back as a fresh process: the player ends up in the lobby, told the room is gone", async () => {
  const s = await startApp();
  const room = await openRoom(s.base);
  const conn = new Connection({
    url: s.wsUrl,
    handshake: () => msg.join(room.id, "Ace"),
    backoff: { baseMs: 30, capMs: 100 },
    connectTimeoutMs: 500,
  });
  conn.connect();
  await waitFor(conn, "joined");
  const lost: string[] = [];
  watchForLoss(conn, { giveUpAfterMs: 5000, onLost: (r) => lost.push(r) });

  await s.app.shutdown(); // the server goes away…
  const config = loadConfig({ PORT: String(s.port), LOG_DIR: s.dir, CLIENT_DIST: s.dir });
  const restarted = createApp(config, silentLogger); // …and a brand-new process takes the port
  await restarted.listen();
  try {
    await waitFor(conn, "closed", 8000);
    assert.equal(lost.length, 1);
    assert.match(lost[0] ?? "", /перезапустився.*кімнати вже немає/);
  } finally {
    await restarted.shutdown();
    await s.close();
  }
});

test("2b. the server dies and stays down: after the grace period the player is sent back to the lobby", async () => {
  const s = await startApp();
  const room = await openRoom(s.base);
  const conn = new Connection({
    url: s.wsUrl,
    handshake: () => msg.join(room.id, "Ace"),
    backoff: { baseMs: 30, capMs: 100 },
    connectTimeoutMs: 300,
  });
  conn.connect();
  await waitFor(conn, "joined");
  const lost = new Promise<string>((resolve) =>
    watchForLoss(conn, { giveUpAfterMs: 600, onLost: resolve }),
  );
  const t0 = performance.now();
  await s.app.shutdown();
  const reason = await Promise.race([lost, sleep(5000).then(() => "never")]);
  conn.close();
  assert.match(
    reason,
    /Сервер перезапускається і ще не відповідає/,
    "it had said `shutdown` before it went",
  );
  assert.ok(performance.now() - t0 < 3000);
  await s.close();
});

test("3. a flood of garbage: the sender is cut off at the first bad frame, and another room's ticks do not stall", async () => {
  const s = await startApp({ HEARTBEAT_MS: "60000" });
  try {
    const quiet = await openRoom(s.base, { name: "Quiet" });
    const noisy = await openRoom(s.base, { name: "Noisy" });
    const bystander = await joined(s.wsUrl, quiet.id, "Bystander");
    const gaps = watchGaps(bystander.socket);
    const flooders = await Promise.all(
      ["text", "binary", "chat"].map((kind) => joined(s.wsUrl, noisy.id, `Flood-${kind}`)),
    );
    await sleep(300);

    // ~1000 frames per second from each of three clients, for two seconds
    const t0 = performance.now();
    const garbage = Buffer.from([0xff, 0x00, 0x13, 0x37, 0x42]);
    const timer = setInterval(() => {
      for (let i = 0; i < 10; i++) {
        if (flooders[0]?.socket.readyState === 1) flooders[0].send("{ not json");
        if (flooders[1]?.socket.readyState === 1) flooders[1].socket.send(garbage);
        if (flooders[2]?.socket.readyState === 1)
          flooders[2].send({ v: 1, type: "chat", text: "spam" });
      }
    }, 10);
    const closes = await Promise.all(flooders.map((f) => f.closed));
    clearInterval(timer);
    assert.ok(performance.now() - t0 < 1500, "all three were cut off almost at once");
    assert.deepEqual(
      closes.map((c) => c.code),
      [4000, 4000, 1008],
      "bad JSON and bad bytes → 4000, a chat flood → 1008 (rate limit)",
    );
    await sleep(500);

    // the bystander's snapshots never stopped for long (30 Hz = 33 ms; allow a generous CI margin)
    assert.ok(gaps.messages > 20);
    assert.ok(gaps.maxGapMs < 250, `bystander saw a ${gaps.maxGapMs.toFixed(0)} ms gap`);

    const text = await (await fetch(`${s.base}/metrics`)).text();
    const line = (name: string, labels: string): number =>
      Number(
        text
          .split("\n")
          .find((l) => l.startsWith(`${name}${labels} `))
          ?.split(" ")
          .at(-1),
      );
    assert.equal(line("dogfight_rejections_total", '{reason="bad_message"}'), 2);
    assert.equal(line("dogfight_rejections_total", '{reason="rate_limit"}'), 1);
    assert.ok(
      line("dogfight_tick_p99_seconds", "") < 1 / 30,
      "every room's tick p99 stayed inside its budget",
    );
    bystander.socket.close();
  } finally {
    await s.close();
  }
});

test("a client that connects and says nothing is dropped after the join timeout, and counted", async () => {
  const s = await startApp({ JOIN_TIMEOUT_MS: "150" });
  try {
    const c = connect(s.wsUrl);
    await c.opened;
    assert.equal((await c.closed).code, 4003);
    const text = await (await fetch(`${s.base}/metrics`)).text();
    assert.match(text, /dogfight_rejections_total\{reason="join_timeout"\} 1/);
  } finally {
    await s.close();
  }
});
