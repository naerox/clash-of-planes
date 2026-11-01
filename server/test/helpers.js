import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { binaryCodec } from "@dogfight/shared";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/index.js";
import { silentLogger } from "../src/logger.js";

/** A real server on a random port, with its own empty LOG_DIR; `overrides` are env strings. */
export async function startApp(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dogfight-test-"));
  const config = loadConfig({ PORT: "0", LOG_DIR: dir, CLIENT_DIST: dir, ...overrides });
  const app = createApp(config, silentLogger);
  const { port } = await app.listen();
  return {
    app,
    dir,
    port,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async close() {
      await app.shutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function createRoom(base, body = { name: "Test" }) {
  const res = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * A WebSocket client with an awaitable message queue and close promise.
 *
 * Control messages (joined, roster, chat, error) are read with `next()`. GAME messages
 * (snapshot, pong) — snapshots now arrive 30 times a second, as binary frames — are kept apart, so
 * the chat-and-roster tests do not have to care: read them with `.snapshots` / `untilSnapshot()`
 * and `nextPong()`.
 */
export function connect(url, options) {
  const socket = new WebSocket(url, options);
  const inbox = [];
  const waiting = [];
  const snapshots = [];
  const pongs = [];
  const pongWaiting = [];
  socket.on("message", (data, isBinary) => {
    let msg;
    try {
      msg = isBinary ? binaryCodec.decode(data) : JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "snapshot") {
      snapshots.push(msg);
      return;
    }
    if (msg.type === "pong") {
      const waiter = pongWaiting.shift();
      if (waiter) waiter(msg);
      else pongs.push(msg);
      return;
    }
    const waiter = waiting.shift();
    if (waiter) waiter(msg);
    else inbox.push(msg);
  });
  const closed = new Promise((resolve) =>
    socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  socket.on("error", () => {}); // tests assert on `closed`, not on transport errors
  const wait = (queue, waiters, timeoutMs, what) => {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for a ${what}`)), timeoutMs);
      waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  };
  return {
    socket,
    closed,
    snapshots,
    opened: new Promise((resolve) => socket.once("open", resolve)),
    next: (timeoutMs = 2000) => wait(inbox, waiting, timeoutMs, "message"),
    nextPong: (timeoutMs = 2000) => wait(pongs, pongWaiting, timeoutMs, "pong"),
    /** Waits until a snapshot satisfying `predicate` has arrived (also checks ones already seen). */
    async untilSnapshot(predicate, timeoutMs = 3000) {
      const t0 = Date.now();
      for (;;) {
        const hit = snapshots.find(predicate);
        if (hit) return hit;
        if (Date.now() - t0 > timeoutMs)
          throw new Error("timed out waiting for a matching snapshot");
        await sleep(10);
      }
    },
    send: (msg) =>
      socket.send(typeof msg === "string" || msg instanceof Uint8Array ? msg : JSON.stringify(msg)),
  };
}

export const hello = (room, name, codec) => ({
  v: 1,
  type: "join",
  room,
  name,
  ...(codec ? { codec } : {}),
});
export const say = (text) => ({ v: 1, type: "chat", text });

export async function joined(url, room, name, { codec, options } = {}) {
  const c = connect(url, options);
  await c.opened;
  c.send(hello(room, name, codec));
  const first = await c.next();
  if (first.type !== "joined") throw new Error(`expected joined, got ${JSON.stringify(first)}`);
  return { ...c, first };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
