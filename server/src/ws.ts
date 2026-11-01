// WebSocket connection lifecycle: join handshake, validation, heartbeat, rate limit,
// slow-client policy — and (Lab 5) the game plane: binary/JSON input in, snapshots out, with
// an optional artificial-lag simulator in both paths. The rooms themselves know nothing
// about any of this; the authoritative simulation lives in match.ts.

import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  CLOSE,
  CodecError,
  TICK_RATE,
  binaryCodec,
  clampNetsim,
  getCodec,
  parseClientMessage,
  toClient,
  utf8Length,
  type InputMessage,
  type PingMessage,
} from "@dogfight/shared";
import type { ServerConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import {
  Room,
  RoomError,
  type ControlFrame,
  type Player,
  type RoomManager,
  type SendOptions,
} from "./rooms.ts";
import { TokenBucket } from "./rateLimit.ts";
import { NetSim } from "./netsim.ts";
import { startHeartbeat } from "./heartbeat.ts";

/** A WebSocket close reason may be at most 123 BYTES. Reasons here can echo client input
 * (an unknown message type, say), and `socket.close()` throws on a longer one — so cut it
 * by bytes, on a character boundary. */
export function closeReason(text: string, maxBytes = 120): string {
  let out = "";
  for (const ch of text) {
    if (Buffer.byteLength(out + ch) > maxBytes) break;
    out += ch;
  }
  return out;
}

/**
 * Builds a player's `send`. Two limits on `socket.bufferedAmount` (bytes accepted by
 * `send()` but not yet written to the network — it grows when the client reads slower than
 * we write):
 *   > slowDropBytes   non-critical messages (chat; Lab 5's snapshots) are dropped for that
 *                     client, so one slow reader cannot make us buffer without bound;
 *   > slowCloseBytes  even critical ones are piling up — close the connection (1013).
 */
/** A player's outgoing channel: `send` for JSON control messages, `send.raw` for any frame. */
export interface Sender {
  (message: ControlFrame, options?: SendOptions): boolean;
  /** `data`: a string (text frame) or Uint8Array (binary frame). */
  raw(data: string | Uint8Array, options?: SendOptions): boolean;
}

export interface ConnectionStats {
  dropped: number;
  bytesIn: number;
  bytesOut: number;
}

/** `ws` hands over a Buffer, an ArrayBuffer or a list of fragments; the codecs want bytes. */
function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

/** The slice of a WebSocket the sender uses — which is also what lets a test pass a plain object. */
export interface SenderSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

export function createSender(
  socket: SenderSocket,
  config: Pick<ServerConfig, "slowCloseBytes" | "slowDropBytes">,
  log: Logger,
  stats: Pick<ConnectionStats, "dropped"> = { dropped: 0 },
): Sender {
  function sendRaw(data: string | Uint8Array, { critical = true }: SendOptions = {}): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const buffered = socket.bufferedAmount;
    if (buffered > config.slowCloseBytes) {
      log.warn("slow client closed", { buffered });
      socket.close(CLOSE.TRY_LATER, "too slow");
      return false;
    }
    if (!critical && buffered > config.slowDropBytes) {
      stats.dropped++;
      return false;
    }
    socket.send(data, (err) => {
      if (err) log.warn("send failed", { error: err.message });
    });
    return true;
  }
  function send(msg: ControlFrame, opts?: SendOptions): boolean {
    return sendRaw(JSON.stringify(msg), opts);
  }
  return Object.assign(send, { raw: sendRaw });
}

/** Roster and chat fan-out: one place subscribes to each new room. */
export function attachBroadcast(room: Room): void {
  room.on("join", (player) => {
    // the newcomer already got the full roster inside `joined`
    room.broadcast(toClient.roster(room.roster()), { except: player.id });
  });
  room.on("leave", () => room.broadcast(toClient.roster(room.roster())));
  room.on("chat", (message) => room.broadcast(toClient.chat(message), { critical: false }));
}

export interface WsDeps {
  server: Server;
  rooms: RoomManager;
  config: ServerConfig;
  log: Logger;
}

/** Everything the server remembers about one socket. */
interface ConnectionState {
  missed: number;
  player: Player | null;
  room: Room | null;
  readonly bucket: TokenBucket;
  readonly pingBucket: TokenBucket;
  readonly stats: ConnectionStats;
  readonly net: NetSim;
}

export function attachWebSocket({ server, rooms, config, log }: WsDeps) {
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: config.maxMessageBytes });
  wss.on("error", (err) => log.error("wss error", { error: err.message }));

  const states = new WeakMap<WebSocket, ConnectionState>();

  wss.on("connection", (socket, req) => {
    const connId = randomUUID().slice(0, 8);
    const state: ConnectionState = {
      missed: 0,
      player: null,
      room: null,
      bucket: new TokenBucket({ capacity: config.rateBurst, perSec: config.ratePerSec }),
      pingBucket: new TokenBucket({ capacity: 10, perSec: 5 }),
      stats: { dropped: 0, bytesIn: 0, bytesOut: 0 },
      net: new NetSim(), // artificial latency / jitter / loss, off unless asked for
    };
    states.set(socket, state);
    const send = createSender(socket, config, log, state.stats);

    // `?lag=100&jitter=30&drop=0.02` on the WebSocket URL: handy for a quick demo. Only when the
    // server allows network simulation at all (ENABLE_NETSIM; off when NODE_ENV=production).
    if (config.netsim) {
      const q = new URL(req.url ?? "/", "http://localhost").searchParams;
      const initial = clampNetsim({
        latency: Number(q.get("lag")),
        jitter: Number(q.get("jitter")),
        drop: Number(q.get("drop")),
      });
      state.net.configure(initial);
    }
    const close = (code: number, reason: string): void => {
      log.info("closing", { connId, code, reason });
      socket.close(code, closeReason(reason));
    };

    // An "error" event without a listener would throw and take the whole process down.
    socket.on("error", (err) => log.warn("socket error", { connId, error: err.message }));
    socket.on("pong", () => (state.missed = 0));

    const joinTimer = setTimeout(
      () => close(CLOSE.JOIN_TIMEOUT, "join expected within the timeout"),
      config.joinTimeoutMs,
    );

    socket.on("close", () => {
      clearTimeout(joinTimer);
      state.net.cancel(); // nothing may be delivered to (or from) a connection that is gone
      if (state.room && state.player) state.room.leave(state.player);
      log.info("disconnected", { connId, dropped: state.stats.dropped });
    });

    socket.on("message", (data, isBinary) => {
      const bytes = toBytes(data);
      state.stats.bytesIn += bytes.length;
      try {
        onMessage(bytes, isBinary);
      } catch (err: unknown) {
        // A bug while handling one client's message must cost that client its connection,
        // not every other player the server (an exception in a listener is uncaught).
        log.error("handler failed", {
          connId,
          error: err instanceof Error ? err.stack : String(err),
        });
        socket.terminate(); // do not try anything fancy while handling a failure
      }
    });

    /** The game plane: an INPUT or a PING, after decoding. The simulated inbound link sits here. */
    function onGameMessage(room: Room, player: Player, msg: InputMessage | PingMessage): void {
      const match = room.match;
      if (!match) return;
      switch (msg.type) {
        case "input":
          // the input reaches the match later (or never)
          state.net.in.send(() => {
            if (state.room) match.receiveInput(player, msg);
          });
          return;
        case "ping":
          if (!state.pingBucket.take()) return; // a ping flood would be a pong flood: ignore
          state.net.in.send(() => {
            if (state.room) player.deliverControl({ type: "pong", t: msg.t, tick: match.tick });
          });
          return;
        default: {
          const unreachable: never = msg;
          return unreachable;
        }
      }
    }

    function onJoin(msg: { room: string; name: string; codec: "binary" | "json" }): void {
      if (state.room) return close(CLOSE.ALREADY_JOINED, "already joined");
      const room = rooms.get(msg.room);
      if (!room) {
        send(toClient.error("no_such_room", "no such room"));
        return close(CLOSE.JOIN_REJECTED, "no such room");
      }
      const match = room.match;
      if (!match) {
        send(toClient.error("no_match", "this room has no running match"));
        return close(CLOSE.JOIN_REJECTED, "no match");
      }
      const codec = getCodec(msg.codec);
      const player: Player = {
        id: randomUUID().slice(0, 8),
        name: msg.name,
        codec,
        shipId: null, // the room's match gives the player a ship while handling "join"
        send,
        /** Snapshots: encoded in this connection's codec, delayed by the simulated link,
         * and non-critical — a client that cannot keep up misses some instead of making us
         * buffer them (Lab 4's slow-client policy). Returns the encoded size. */
        deliver(snapshot) {
          const data = codec.encode(snapshot);
          const bytes = typeof data === "string" ? utf8Length(data) : data.length;
          state.stats.bytesOut += bytes;
          state.net.out.send(() => send.raw(data, { critical: false }));
          return bytes;
        },
        /** A frame the match encoded for us (see `Match.#broadcast`): the same path, minus the encoding. */
        deliverFrame(data) {
          state.stats.bytesOut += data.length;
          state.net.out.send(() => send.raw(data, { critical: false }));
          return data.length;
        },
        /** Pongs: same path, same codec, but critical enough that we do not drop them for lag. */
        deliverControl(message) {
          const data = codec.encode(message);
          state.stats.bytesOut += typeof data === "string" ? utf8Length(data) : data.length;
          state.net.out.send(() => send.raw(data, { critical: false }));
        },
        kick(reason) {
          close(CLOSE.POLICY, reason);
        },
      };
      try {
        room.join(player);
      } catch (err: unknown) {
        if (!(err instanceof RoomError)) throw err;
        send(toClient.error(err.code, err.message));
        return close(CLOSE.JOIN_REJECTED, err.message);
      }
      clearTimeout(joinTimer);
      state.room = room;
      state.player = player;
      log.info("joined", { connId, room: room.id, name: player.name, codec: msg.codec });
      // `join` already told the others; the newcomer gets the room, roster, ship and match
      // parameters in one message — everything the client needs to start predicting
      send(
        toClient.joined({
          type: "joined",
          room: room.info(),
          you: player.id,
          shipId: player.shipId,
          players: room.roster(),
          seed: match.seed,
          tickRate: TICK_RATE,
          tick: match.tick,
          codec: msg.codec,
        }),
      );
    }

    function onMessage(data: Uint8Array, isBinary: boolean): void {
      if (isBinary) {
        const { room, player } = state;
        if (!room || !player) return close(CLOSE.NOT_JOINED, "join first");
        if (player.codec !== binaryCodec)
          return close(CLOSE.UNSUPPORTED, "this connection uses json");
        let msg;
        try {
          msg = binaryCodec.decode(data);
        } catch (err: unknown) {
          if (!(err instanceof CodecError)) throw err;
          return close(CLOSE.BAD_MESSAGE, err.message);
        }
        if (msg.type !== "input" && msg.type !== "ping")
          return close(CLOSE.UNKNOWN_TYPE, `unexpected ${msg.type}`);
        return onGameMessage(room, player, msg);
      }

      // The only door from bytes to a typed message. It never throws: a broken frame is a
      // result, we log it, say why, and close the socket (as in Lab 4).
      const result = parseClientMessage(data, { maxBytes: config.maxMessageBytes });
      if (!result.ok) {
        log.warn("bad message", { connId, code: result.code, reason: result.reason });
        return close(result.code, result.reason);
      }
      const { msg } = result;
      const { room, player } = state;

      if (msg.type === "input" || msg.type === "ping") {
        // JSON-codec game messages are not charged to the chat rate limit; the match has its own
        if (!room || !player) return close(CLOSE.NOT_JOINED, "join first");
        if (player.codec.binary) return close(CLOSE.UNSUPPORTED, "this connection uses binary");
        return onGameMessage(room, player, msg);
      }

      if (!state.bucket.take()) return close(CLOSE.POLICY, "rate limit exceeded");

      if (msg.type === "join") return onJoin(msg);

      if (!room || !player) return close(CLOSE.NOT_JOINED, "join first");
      switch (msg.type) {
        case "chat":
          room.chat(player, msg.text);
          return;
        case "leave":
          return close(CLOSE.NORMAL, "bye");
        case "netsim":
          if (!config.netsim) {
            send(
              toClient.error("netsim_disabled", "network simulation is disabled on this server"),
            );
          } else {
            state.net.configure(msg);
            log.info("netsim", { connId, ...state.net.settings });
          }
          return;
        default: {
          const unreachable: never = msg;
          return unreachable;
        }
      }
    }
  });

  const stopHeartbeat = startHeartbeat({
    clients: () => wss.clients,
    stateOf: (socket) => states.get(socket),
    intervalMs: config.heartbeatMs,
    maxMissedPongs: config.maxMissedPongs,
    log,
  });

  return {
    wss,
    get clients() {
      return wss.clients.size;
    },
    /** Tell every client we are going away (1001), give them `graceMs`, then cut the rest. */
    async close(graceMs = config.shutdownGraceMs): Promise<void> {
      stopHeartbeat();
      for (const socket of wss.clients) socket.close(CLOSE.GOING_AWAY, "server shutting down");
      const deadline = Date.now() + graceMs;
      while (wss.clients.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
