import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
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

/** A WebSocket client with an awaitable message queue and close promise. */
export function connect(url, options) {
  const socket = new WebSocket(url, options);
  const inbox = [];
  const waiting = [];
  socket.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    const waiter = waiting.shift();
    if (waiter) waiter(msg);
    else inbox.push(msg);
  });
  const closed = new Promise((resolve) =>
    socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  socket.on("error", () => {}); // tests assert on `closed`, not on transport errors
  return {
    socket,
    closed,
    opened: new Promise((resolve) => socket.once("open", resolve)),
    next(timeoutMs = 2000) {
      if (inbox.length) return Promise.resolve(inbox.shift());
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timed out waiting for a message")), timeoutMs);
        waiting.push((m) => {
          clearTimeout(t);
          resolve(m);
        });
      });
    },
    send: (msg) => socket.send(typeof msg === "string" ? msg : JSON.stringify(msg)),
  };
}

export const hello = (room, name) => ({ v: 1, type: "join", room, name });
export const say = (text) => ({ v: 1, type: "chat", text });

export async function joined(url, room, name) {
  const c = connect(url);
  await c.opened;
  c.send(hello(room, name));
  const first = await c.next();
  if (first.type !== "joined") throw new Error(`expected joined, got ${JSON.stringify(first)}`);
  return { ...c, first };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
