import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type ClientOptions } from "ws";
import { z } from "zod";
import {
  binaryCodec,
  parseServerMessage,
  roomInfoSchema,
  type CodecName,
  type JoinedMessage,
  type PongMessage,
  type RoomInfo,
  type ServerControl,
  type ServerControlOf,
  type SnapshotMessage,
} from "@dogfight/shared";
import { loadConfig, type Env } from "../src/config.ts";
import { createApp } from "../src/index.ts";
import { silentLogger } from "../src/logger.ts";

/** A real server on a random port, with its own empty LOG_DIR; `overrides` are env strings. */
export async function startApp(overrides: Env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dogfight-test-"));
  const config = loadConfig({ PORT: "0", LOG_DIR: dir, CLIENT_DIST: dir, ...overrides });
  const app = createApp(config, silentLogger);
  const { port }: AddressInfo = await app.listen();
  return {
    app,
    dir,
    port,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async close(): Promise<void> {
      await app.shutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export type TestServer = Awaited<ReturnType<typeof startApp>>;

/** POST /api/rooms. The body is `unknown`: it is whatever the server said. */
export async function createRoom(
  base: string,
  body: unknown = { name: "Test" },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Creates a room and returns it, checked against the same schema the real client uses. */
export async function openRoom(base: string, body: unknown = { name: "Test" }): Promise<RoomInfo> {
  const { status, body: created } = await createRoom(base, body);
  if (status !== 201) throw new Error(`expected 201, got ${status}: ${JSON.stringify(created)}`);
  return roomInfoSchema.parse(created);
}

export interface CloseResult {
  readonly code: number;
  readonly reason: string;
}

/**
 * A WebSocket client with an awaitable message queue and close promise.
 *
 * Control messages (joined, roster, chat, error) are read with `next()` / `nextOf()`. GAME
 * messages (snapshot, pong) — snapshots now arrive 30 times a second, as binary frames — are
 * kept apart, so the chat-and-roster tests do not have to care: read them with `.snapshots` /
 * `untilSnapshot()` and `nextPong()`. Everything is decoded by the real schemas and codecs, so a
 * message the server got wrong is dropped here rather than reaching a test half-typed.
 */
export function connect(url: string, options?: ClientOptions) {
  const socket = new WebSocket(url, options);
  const inbox: ServerControl[] = [];
  const waiting: ((m: ServerControl) => void)[] = [];
  const snapshots: SnapshotMessage[] = [];
  const pongs: PongMessage[] = [];
  const pongWaiting: ((m: PongMessage) => void)[] = [];
  socket.on("message", (data, isBinary) => {
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data;
    let msg;
    if (isBinary) {
      try {
        msg = binaryCodec.decode(bytes);
      } catch {
        return;
      }
    } else {
      const parsed = parseServerMessage(bytes.toString());
      if (!parsed.ok) return;
      msg = parsed.msg;
    }
    switch (msg.type) {
      case "snapshot":
        snapshots.push(msg);
        return;
      case "pong": {
        const waiter = pongWaiting.shift();
        if (waiter) waiter(msg);
        else pongs.push(msg);
        return;
      }
      case "joined":
      case "roster":
      case "chat":
      case "error":
      case "shutdown": {
        const waiter = waiting.shift();
        if (waiter) waiter(msg);
        else inbox.push(msg);
        return;
      }
      default:
        return; // an input or a ping coming FROM the server: nobody sends those
    }
  });
  const closed = new Promise<CloseResult>((resolve) =>
    socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  socket.on("error", () => {}); // tests assert on `closed`, not on transport errors
  const wait = <T>(queue: T[], waiters: ((m: T) => void)[], timeoutMs: number, what: string) => {
    const ready = queue.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for a ${what}`)), timeoutMs);
      waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  };
  const next = (timeoutMs = 2000): Promise<ServerControl> =>
    wait(inbox, waiting, timeoutMs, "message");
  return {
    socket,
    closed,
    snapshots,
    opened: new Promise<void>((resolve) => socket.once("open", () => resolve())),
    next,
    /** The next control message, which must be of this type. */
    async nextOf<T extends ServerControl["type"]>(type: T, timeoutMs?: number) {
      const m = await next(timeoutMs);
      if (!isOfType(m, type)) throw new Error(`expected ${type}, got ${JSON.stringify(m)}`);
      return m;
    },
    nextPong: (timeoutMs = 2000): Promise<PongMessage> =>
      wait(pongs, pongWaiting, timeoutMs, "pong"),
    /** Waits until a snapshot satisfying `predicate` has arrived (also checks ones already seen). */
    async untilSnapshot(
      predicate: (s: SnapshotMessage) => boolean,
      timeoutMs = 3000,
    ): Promise<SnapshotMessage> {
      const t0 = Date.now();
      for (;;) {
        const hit = snapshots.find(predicate);
        if (hit) return hit;
        if (Date.now() - t0 > timeoutMs)
          throw new Error("timed out waiting for a matching snapshot");
        await sleep(10);
      }
    },
    /** Sends a string/bytes as they are, or an object as JSON. */
    send: (msg: unknown): void =>
      socket.send(typeof msg === "string" || msg instanceof Uint8Array ? msg : JSON.stringify(msg)),
  };
}

function isOfType<T extends ServerControl["type"]>(
  m: ServerControl,
  type: T,
): m is ServerControlOf<T> {
  return m.type === type;
}

export type TestClient = ReturnType<typeof connect>;

export const hello = (room: string, name: string, codec?: CodecName) => ({
  v: 1,
  type: "join",
  room,
  name,
  ...(codec ? { codec } : {}),
});
export const say = (text: string) => ({ v: 1, type: "chat", text });

export async function joined(
  url: string,
  room: string,
  name: string,
  { codec, options }: { codec?: CodecName; options?: ClientOptions } = {},
): Promise<TestClient & { first: JoinedMessage }> {
  const c = connect(url, options);
  await c.opened;
  c.send(hello(room, name, codec));
  const first = await c.nextOf("joined");
  return { ...c, first };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A JSON object body, checked: tests read fields from it instead of trusting `any`. */
export async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return z.record(z.string(), z.unknown()).parse(await res.json());
}

/** The body of a `createRoom` call as an object (it is `unknown` until looked at). */
export function asObject(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}
