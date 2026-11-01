// WebSocket connection lifecycle: join handshake, validation, heartbeat, rate limit,
// slow-client policy — and (Lab 5) the game plane: binary/JSON input in, snapshots out, with
// an optional artificial-lag simulator in both paths. The rooms themselves know nothing
// about any of this; the authoritative simulation lives in match.js.

import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  CLOSE,
  CodecError,
  TICK_RATE,
  binaryCodec,
  clampNetsim,
  getCodec,
  toClient,
  utf8Length,
  validate,
} from "@dogfight/shared";
import { RoomError } from "./rooms.js";
import { TokenBucket } from "./rateLimit.js";
import { NetSim } from "./netsim.js";

/** A WebSocket close reason may be at most 123 BYTES. Reasons here can echo client input
 * (an unknown message type, say), and `socket.close()` throws on a longer one — so cut it
 * by bytes, on a character boundary. */
export function closeReason(text, maxBytes = 120) {
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
export function createSender(socket, config, log, stats = { dropped: 0 }) {
  /** `data`: a string (text frame) or Uint8Array (binary frame). */
  function sendRaw(data, { critical = true } = {}) {
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
  function send(msg, opts) {
    return sendRaw(JSON.stringify(msg), opts);
  }
  send.raw = sendRaw;
  return send;
}

/** Roster and chat fan-out: one place subscribes to each new room. */
export function attachBroadcast(room) {
  room.on("join", (player) => {
    // the newcomer already got the full roster inside `joined`
    room.broadcast(toClient.roster(room.roster()), { except: player.id });
  });
  room.on("leave", () => room.broadcast(toClient.roster(room.roster())));
  room.on("chat", (message) => room.broadcast(toClient.chat(message), { critical: false }));
}

export function attachWebSocket({ server, rooms, config, log }) {
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: config.maxMessageBytes });
  wss.on("error", (err) => log.error("wss error", { error: err.message }));

  const states = new WeakMap(); // socket → { missed }

  wss.on("connection", (socket, req) => {
    const connId = randomUUID().slice(0, 8);
    const state = {
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
      const q = new URL(req.url, "http://localhost").searchParams;
      const initial = clampNetsim({
        latency: Number(q.get("lag")),
        jitter: Number(q.get("jitter")),
        drop: Number(q.get("drop")),
      });
      state.net.configure(initial);
    }
    const close = (code, reason) => {
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
      if (state.room) state.room.leave(state.player);
      log.info("disconnected", { connId, dropped: state.stats.dropped });
    });

    socket.on("message", (data, isBinary) => {
      state.stats.bytesIn += data.length;
      try {
        onMessage(data, isBinary);
      } catch (err) {
        // A bug while handling one client's message must cost that client its connection,
        // not every other player the server (an exception in a listener is uncaught).
        log.error("handler failed", { connId, error: err.stack });
        socket.terminate(); // do not try anything fancy while handling a failure
      }
    });

    /** The game plane: an INPUT or a PING, after decoding. `delay` = the simulated inbound link. */
    function onGameMessage(msg) {
      const player = state.player;
      const match = state.room.match;
      if (msg.type === "input") {
        // the simulated link sits here: the input reaches the match later (or never)
        state.net.in.send(() => {
          if (state.room) match.receiveInput(player, msg);
        });
      } else if (msg.type === "ping") {
        if (!state.pingBucket.take()) return; // a ping flood would be a pong flood: ignore
        state.net.in.send(() => {
          if (state.room) player.deliverControl({ type: "pong", t: msg.t, tick: match.tick });
        });
      }
    }

    function onMessage(data, isBinary) {
      if (isBinary) {
        if (!state.room) return close(CLOSE.NOT_JOINED, "join first");
        if (state.player.codec !== binaryCodec)
          return close(CLOSE.UNSUPPORTED, "this connection uses json");
        let msg;
        try {
          msg = binaryCodec.decode(data);
        } catch (err) {
          if (!(err instanceof CodecError)) throw err;
          return close(CLOSE.BAD_MESSAGE, err.message);
        }
        if (msg.type !== "input" && msg.type !== "ping")
          return close(CLOSE.UNKNOWN_TYPE, `unexpected ${msg.type}`);
        return onGameMessage(msg);
      }

      const result = validate(data, { maxBytes: config.maxMessageBytes });
      if (!result.ok) return close(result.code, result.reason);
      const { msg } = result;

      if (msg.type === "input" || msg.type === "ping") {
        // JSON-codec game messages are not charged to the chat rate limit; the match has its own
        if (!state.room) return close(CLOSE.NOT_JOINED, "join first");
        if (state.player.codec.binary)
          return close(CLOSE.UNSUPPORTED, "this connection uses binary");
        return onGameMessage(msg);
      }

      if (!state.bucket.take()) return close(CLOSE.POLICY, "rate limit exceeded");

      if (msg.type === "join") {
        if (state.room) return close(CLOSE.ALREADY_JOINED, "already joined");
        const room = rooms.get(msg.room);
        if (!room) {
          send(toClient.error("no_such_room", "no such room"));
          return close(CLOSE.JOIN_REJECTED, "no such room");
        }
        const codec = getCodec(msg.codec);
        const player = {
          id: randomUUID().slice(0, 8),
          name: msg.name,
          send,
          codec,
          shipId: null, // the room's match gives the player a ship while handling "join"
          /** Snapshots: encoded in this connection's codec, delayed by the simulated link,
           * and non-critical — a client that cannot keep up misses some instead of making us
           * buffer them (Lab 4's slow-client policy). Returns the encoded size. */
          deliver(snapshot) {
            const data = codec.encode(snapshot);
            const bytes = codec.binary ? data.length : utf8Length(data);
            state.stats.bytesOut += bytes;
            state.net.out.send(() => send.raw(data, { critical: false }));
            return bytes;
          },
          /** Pongs: same path, same codec, but critical enough that we do not drop them for lag. */
          deliverControl(message) {
            const data = codec.encode(message);
            state.stats.bytesOut += codec.binary ? data.length : utf8Length(data);
            state.net.out.send(() => send.raw(data, { critical: false }));
          },
          kick(reason) {
            close(CLOSE.POLICY, reason);
          },
        };
        try {
          room.join(player);
        } catch (err) {
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
            room: room.info(),
            you: player.id,
            shipId: player.shipId,
            players: room.roster(),
            seed: room.match.seed,
            tickRate: TICK_RATE,
            tick: room.match.tick,
            codec: msg.codec,
          }),
        );
        return;
      }

      if (!state.room) return close(CLOSE.NOT_JOINED, "join first");
      if (msg.type === "chat") state.room.chat(state.player, msg.text);
      else if (msg.type === "leave") close(CLOSE.NORMAL, "bye");
      else if (msg.type === "netsim") {
        if (!config.netsim) {
          send(toClient.error("netsim_disabled", "network simulation is disabled on this server"));
        } else {
          state.net.configure(msg);
          log.info("netsim", { connId, ...state.net.settings });
        }
      }
    }
  });

  // Heartbeat: one timer for all sockets. Each tick pings; every pong resets `missed`.
  // A socket that has left maxMissedPongs pings unanswered is dead (a laptop lid, a NAT that
  // forgot the mapping): TCP would not tell us for minutes, so we terminate it ourselves.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const state = states.get(socket);
      if (!state) continue;
      if (state.missed >= config.maxMissedPongs) {
        log.warn("heartbeat lost", { missed: state.missed });
        socket.terminate();
        continue;
      }
      state.missed++;
      socket.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  return {
    wss,
    get clients() {
      return wss.clients.size;
    },
    /** Tell every client we are going away (1001), give them `graceMs`, then cut the rest. */
    async close(graceMs = config.shutdownGraceMs) {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.close(CLOSE.GOING_AWAY, "server shutting down");
      const deadline = Date.now() + graceMs;
      while (wss.clients.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}
