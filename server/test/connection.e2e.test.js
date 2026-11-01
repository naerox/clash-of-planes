// The browser-side `Connection` (client/src/net/connection.js) against the REAL server,
// using Node 22's built-in WebSocket. This is where reconnect-and-rejoin is proven end to end.

import test from "node:test";
import assert from "node:assert/strict";
import { Connection } from "../../client/src/net/connection.js";
import { msg } from "../../client/src/net/protocol.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/index.js";
import { silentLogger } from "../src/logger.js";
import { createRoom, startApp } from "./helpers.js";

const waitFor = (target, type, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for "${type}"`)), ms);
    target.addEventListener(
      type,
      (e) => {
        clearTimeout(t);
        resolve(e.detail);
      },
      { once: true },
    );
  });

test("joins through the real handshake and chats; messages queued before open arrive after the join", async () => {
  const s = await startApp();
  try {
    const { body: room } = await createRoom(s.base);
    const conn = new Connection({ url: s.wsUrl, handshake: () => msg.join(room.id, "Ace") });
    const chat = waitFor(conn, "chat");
    conn.connect();
    conn.send(msg.chat("queued before the socket opened"));
    const joined = await waitFor(conn, "joined");
    assert.equal(joined.room.id, room.id);
    assert.equal((await chat).text, "queued before the socket opened");
    conn.close();
  } finally {
    await s.close();
  }
});

test("the server drops the connection → the client reconnects, re-joins, and flushes what it queued meanwhile", async () => {
  const s = await startApp();
  try {
    const { body: room } = await createRoom(s.base);
    const keeper = new Connection({ url: s.wsUrl, handshake: () => msg.join(room.id, "Keeper") });
    keeper.connect();
    await waitFor(keeper, "joined");

    const conn = new Connection({
      url: s.wsUrl,
      handshake: () => msg.join(room.id, "Ace"),
      backoff: { baseMs: 40, capMs: 200 },
    });
    conn.connect();
    await waitFor(conn, "joined");

    const states = [];
    conn.addEventListener("status", (e) => states.push(e.detail.state));
    // subscribe BEFORE the event can happen: an event, unlike a promise, is not remembered
    const keeperHears = waitFor(keeper, "chat");
    // a network failure from the server's side — for Ace only, so the keeper holds the room open
    [...s.app.ws.wss.clients].at(-1).terminate();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(conn.send(msg.chat("sent while offline")), true);

    const again = await waitFor(conn, "joined"); // the handshake ran again on the new socket
    assert.equal(again.room.id, room.id);
    assert.ok(states.includes("reconnecting") && states.at(-1) === "open", states.join());
    // the offline message really went through: the keeper sees it
    const seen = await keeperHears;
    assert.equal(seen.text, "sent while offline");
    conn.close();
    keeper.close();
  } finally {
    await s.close();
  }
});

test("a join the server refuses is fatal: the client stops instead of retrying forever", async () => {
  const s = await startApp();
  try {
    const conn = new Connection({ url: s.wsUrl, handshake: () => msg.join("nope-0000", "Ace") });
    const err = waitFor(conn, "error");
    const closed = waitFor(conn, "closed");
    conn.connect();
    assert.equal((await err).code, "no_such_room");
    const info = await closed;
    assert.deepEqual([info.code, info.fatal], [4004, true]);
    assert.equal(conn.state, "closed");
  } finally {
    await s.close();
  }
});

test("a server restart (1001 → connection refused → back up) is survived; the room is gone, so the re-join is refused", async () => {
  const s = await startApp();
  const { body: room } = await createRoom(s.base);
  const conn = new Connection({
    url: s.wsUrl,
    handshake: () => msg.join(room.id, "Ace"),
    backoff: { baseMs: 30, capMs: 100 },
    connectTimeoutMs: 500,
  });
  conn.connect();
  await waitFor(conn, "joined");

  const states = [];
  conn.addEventListener("status", (e) => states.push(e.detail.state));
  const closedFor = waitFor(conn, "closed", 8000); // events are not remembered: subscribe first
  await s.app.shutdown(); // clients get 1001 "going away"
  assert.ok(["reconnecting", "connecting"].includes(conn.state));

  // same port, brand-new process state: rooms live in memory, so the old room does not exist
  const config = loadConfig({ PORT: String(s.port), LOG_DIR: s.dir, CLIENT_DIST: s.dir });
  const restarted = createApp(config, silentLogger);
  await restarted.listen();
  try {
    const closed = await closedFor;
    assert.equal(closed.code, 4004, "reached the new server, which refused the stale room");
    assert.ok(states.includes("reconnecting"));
  } finally {
    await restarted.shutdown();
    await s.close();
  }
});
