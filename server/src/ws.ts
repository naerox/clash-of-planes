// WebSocket connection lifecycle: join handshake, validation, heartbeat, rate limit,
// slow-client policy — and (Lab 5) the game plane: binary/JSON input in, snapshots out, with
// an optional artificial-lag simulator in both paths. The rooms themselves know nothing
// about any of this; the authoritative simulation lives in match.ts.

import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, Server } from "node:http";
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
import type { Metrics, RejectionReason } from "./metrics.ts";

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

// ── who is connecting, and from where ─────────────────────────────────────────────────

/**
 * The address a connection really comes from. Behind a reverse proxy the TCP peer is the proxy
 * itself, so the client's address is in `X-Forwarded-For` — but only the entries added by OUR
 * proxies can be trusted: the client may send a header of its own, and every proxy appends the
 * address it saw. With `hops` trusted proxies the real client is the `hops`-th entry from the END.
 * `hops = 0` (the default) ignores the header altogether.
 */
export function clientIp(
  req: { headers: IncomingHttpHeaders; socket: { remoteAddress?: string | undefined } },
  hops: number,
): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const forwarded = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "");
  const picked = hops > 0 ? chain[chain.length - hops] : undefined;
  return (picked ?? peer).replace(/^::ffff:/, "");
}

/**
 * CORS does not exist for WebSockets: a page on evil.example can `new WebSocket("wss://our.app/ws")`
 * and the browser will happily connect, with the visitor's cookies and network position. The only
 * thing that tells the two apart is the `Origin` header the browser attaches — and a browser
 * cannot be made to lie about it. So we check it on the handshake.
 *
 *   no Origin header   → not a browser (bots, load tests, curl): a script can send any Origin it likes
 *                        anyway, so refusing these would protect nothing — allowed
 *   ALLOWED_ORIGINS set → the origin must be on the list
 *   list empty          → only pages served by this very server (Origin's host equals Host)
 */
export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined) return true;
  if (allowed.length > 0) return allowed.includes(origin);
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false; // "null" (a sandboxed iframe, a file:// page) and garbage
  }
}

/** Which counter a close code belongs to (`null`: a normal goodbye, nothing to count). */
export function rejectionFor(code: number): RejectionReason | null {
  switch (code) {
    case CLOSE.NORMAL:
      return null;
    case CLOSE.GOING_AWAY:
      return "shutdown";
    case CLOSE.POLICY:
      return "rate_limit";
    case CLOSE.TRY_LATER:
      return "slow_client";
    case CLOSE.JOIN_TIMEOUT:
      return "join_timeout";
    case CLOSE.JOIN_REJECTED:
    case CLOSE.ALREADY_JOINED:
      return "join_rejected";
    default:
      return "bad_message";
  }
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

/** Metrics hooks: every frame that really went out, and every client cut off for being slow. */
export interface SenderHooks {
  onFrame?(bytes: number): void;
  onSlowClose?(): void;
}

export function createSender(
  socket: SenderSocket,
  config: Pick<ServerConfig, "slowCloseBytes" | "slowDropBytes">,
  log: Logger,
  stats: Pick<ConnectionStats, "dropped"> = { dropped: 0 },
  hooks: SenderHooks = {},
): Sender {
  function sendRaw(data: string | Uint8Array, { critical = true }: SendOptions = {}): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const buffered = socket.bufferedAmount;
    if (buffered > config.slowCloseBytes) {
      log.warn("slow client closed", { buffered });
      hooks.onSlowClose?.();
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
    hooks.onFrame?.(typeof data === "string" ? utf8Length(data) : data.length);
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
  metrics: Metrics;
}

/** After the server asks a client to leave (a protocol violation), how long it gets to say goodbye. */
const CLOSE_HANDSHAKE_MS = 2000;

/** Everything the server remembers about one socket. */
interface ConnectionState {
  /** We have told this client to go (close code sent). Everything it still sends is ignored. */
  closing: boolean;
  readonly ip: string;
  missed: number;
  player: Player | null;
  room: Room | null;
  readonly bucket: TokenBucket;
  readonly pingBucket: TokenBucket;
  readonly stats: ConnectionStats;
  readonly net: NetSim;
}

export function attachWebSocket({ server, rooms, config, log, metrics }: WsDeps) {
  const connectionsByIp = new Map<string, number>();
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: config.maxMessageBytes,
    // The handshake gate: refuse BEFORE the upgrade, so a rejected client costs us one HTTP
    // response and no WebSocket state at all.
    verifyClient: ({ req, origin }, done) => {
      const ip = clientIp(req, config.trustedProxyHops);
      if (!originAllowed(origin || undefined, req.headers.host, config.allowedOrigins)) {
        metrics.reject("origin");
        log.warn("handshake refused", { reason: "origin", origin, ip });
        return done(false, 403, "origin not allowed");
      }
      if ((connectionsByIp.get(ip) ?? 0) >= config.maxConnectionsPerIp) {
        metrics.reject("ip_limit");
        log.warn("handshake refused", { reason: "ip_limit", ip });
        return done(false, 429, "too many connections from this address");
      }
      done(true);
    },
  });
  wss.on("error", (err) => log.error("wss error", { error: err.message }));

  const states = new WeakMap<WebSocket, ConnectionState>();
  const senders = new WeakMap<WebSocket, Sender>();

  wss.on("connection", (socket, req) => {
    const connId = randomUUID().slice(0, 8);
    const ip = clientIp(req, config.trustedProxyHops);
    connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1);
    metrics.connections.inc();
    const state: ConnectionState = {
      closing: false,
      ip,
      missed: 0,
      player: null,
      room: null,
      bucket: new TokenBucket({ capacity: config.rateBurst, perSec: config.ratePerSec }),
      pingBucket: new TokenBucket({ capacity: 10, perSec: 5 }),
      stats: { dropped: 0, bytesIn: 0, bytesOut: 0 },
      net: new NetSim(), // artificial latency / jitter / loss, off unless asked for
    };
    states.set(socket, state);
    const send = createSender(socket, config, log, state.stats, {
      onFrame(bytes) {
        metrics.messagesOut.inc();
        metrics.bytesOut.inc(bytes);
      },
      onSlowClose: () => metrics.reject("slow_client"),
    });
    senders.set(socket, send);
    // every line from this connection carries its ids; after the join, the room's and the player's too
    let clog = log.child({ connId });

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
      if (state.closing) return; // already told to go; the first reason is the one that counts
      state.closing = true;
      const counted = rejectionFor(code);
      if (counted) metrics.reject(counted);
      clog.info("closing", { code, reason });
      socket.close(code, closeReason(reason));
      // A client that is misbehaving does not owe us a polite goodbye: if it has not answered
      // the close frame shortly, cut the TCP connection. (A flood of frames cannot keep a socket alive.)
      const cut = setTimeout(() => socket.terminate(), CLOSE_HANDSHAKE_MS);
      cut.unref();
      socket.once("close", () => clearTimeout(cut));
    };

    // An "error" event without a listener would throw and take the whole process down.
    socket.on("error", (err) => clog.warn("socket error", { error: err.message }));
    socket.on("pong", () => (state.missed = 0));

    const joinTimer = setTimeout(
      () => close(CLOSE.JOIN_TIMEOUT, "join expected within the timeout"),
      config.joinTimeoutMs,
    );

    socket.on("close", () => {
      clearTimeout(joinTimer);
      state.net.cancel(); // nothing may be delivered to (or from) a connection that is gone
      const left = (connectionsByIp.get(ip) ?? 1) - 1;
      if (left > 0) connectionsByIp.set(ip, left);
      else connectionsByIp.delete(ip);
      if (state.room && state.player) state.room.leave(state.player);
      clog.info("disconnected", { dropped: state.stats.dropped });
    });

    socket.on("message", (data, isBinary) => {
      const bytes = toBytes(data);
      state.stats.bytesIn += bytes.length;
      metrics.bytesIn.inc(bytes.length);
      if (state.closing) return; // we already decided to drop this client: do not even parse what it still sends
      try {
        onMessage(bytes, isBinary);
      } catch (err: unknown) {
        // A bug while handling one client's message must cost that client its connection,
        // not every other player the server (an exception in a listener is uncaught).
        clog.error("handler failed", {
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
      clog = log.child({ connId, roomId: room.id, playerId: player.id });
      clog.info("joined", { name: player.name, codec: msg.codec });
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
          metrics.messagesIn.inc({ type: "invalid" });
          return close(CLOSE.BAD_MESSAGE, err.message);
        }
        metrics.messagesIn.inc({ type: msg.type });
        if (msg.type !== "input" && msg.type !== "ping")
          return close(CLOSE.UNKNOWN_TYPE, `unexpected ${msg.type}`);
        return onGameMessage(room, player, msg);
      }

      // The only door from bytes to a typed message. It never throws: a broken frame is a
      // result, we log it, say why, and close the socket (as in Lab 4).
      const result = parseClientMessage(data, { maxBytes: config.maxMessageBytes });
      if (!result.ok) {
        metrics.messagesIn.inc({ type: "invalid" });
        clog.warn("bad message", { code: result.code, reason: result.reason });
        return close(result.code, result.reason);
      }
      const { msg } = result;
      metrics.messagesIn.inc({ type: msg.type });
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
            clog.info("netsim", { ...state.net.settings });
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
    onLost: () => metrics.reject("heartbeat"),
  });

  return {
    wss,
    get clients() {
      return wss.clients.size;
    },
    /** Open connections per address, for the tests of the per-IP cap. */
    connectionsFrom(ip: string): number {
      return connectionsByIp.get(ip) ?? 0;
    },
    /** Tell every client we are going away (1001), give them `graceMs`, then cut the rest. */
    async close(graceMs = config.shutdownGraceMs): Promise<void> {
      stopHeartbeat();
      for (const socket of wss.clients) {
        // say WHY first (a text frame the client shows), then the close frame: 1001 "going away"
        senders.get(socket)?.(toClient.shutdown("server shutting down", 3000));
        metrics.reject("shutdown");
        socket.close(CLOSE.GOING_AWAY, "server shutting down");
      }
      const deadline = Date.now() + graceMs;
      while (wss.clients.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
