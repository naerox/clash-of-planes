// A WebSocket that survives the network: a send queue while there is no open socket, and
// reconnection with exponentially growing, jittered pauses (Lab 3's retry idea, again).
//
//   idle ──connect()──► connecting ──open──► open ──close (non-fatal)──► reconnecting ─┐
//                           ▲                  │                                       │
//                           └──────────────────┴───────────── timer fires ◄────────────┘
//   any state ──close() / fatal close code──► closed
//
// Events (all CustomEvents, payload in `detail`):
//   "status"  { state, attempt, delayMs? }   every state change
//   "message" { …parsed server message }     and the same detail under its own `type`
//                                            ("joined", "roster", "chat", "error", …;
//                                            in JSON mode also "snapshot" and "pong")
//   "binary"  ArrayBuffer                    a binary frame (the binary codec's snapshots, pongs)
//   "frame"   { size, binary }               every frame that arrived, for bandwidth statistics
//   "closed"  { code, reason, fatal }        final: the connection will not come back
//
// `handshake()` returns the message that must open every connection (the `join`). It is sent
// first on every (re)connect — the server forgot us when the old socket died — and only then
// is the queue flushed, so queued chat lines arrive after the rejoin, in order.

import { isFatalClose } from "./protocol.js";

/** "Equal jitter": half of the exponential step is fixed, half is random. Unlike full jitter
 * it never returns ~0, so a flapping server is not hammered in a tight loop. */
export function reconnectDelay(
  attempt,
  { baseMs = 500, capMs = 10_000, random = Math.random } = {},
) {
  const step = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(step / 2 + (random() * step) / 2);
}

export class Connection extends EventTarget {
  #url;
  #handshake;
  #WebSocket;
  #backoff;
  #maxQueue;
  #connectTimeoutMs;
  #socket = null;
  #queue = [];
  #attempt = 0;
  #timer = null;
  #state = "idle";
  #intentional = false;

  constructor({
    url,
    handshake = null,
    WebSocketImpl = globalThis.WebSocket,
    backoff = {},
    maxQueue = 100,
    connectTimeoutMs = 8000,
  }) {
    super();
    this.#url = url;
    this.#handshake = handshake;
    this.#WebSocket = WebSocketImpl;
    this.#backoff = backoff;
    this.#maxQueue = maxQueue;
    this.#connectTimeoutMs = connectTimeoutMs;
  }

  get state() {
    return this.#state;
  }

  get queued() {
    return this.#queue.length;
  }

  connect() {
    if (this.#state !== "idle") return;
    this.#intentional = false;
    this.#open("connecting");
  }

  /** Sends now if the socket is open, otherwise queues. Returns false only if the queue is full. */
  send(message) {
    if (this.#state === "closed") return false;
    const socket = this.#socket;
    if (this.#state === "open" && socket?.readyState === 1) {
      socket.send(JSON.stringify(message));
      return true;
    }
    if (this.#queue.length >= this.#maxQueue) return false;
    this.#queue.push(message);
    return true;
  }

  /**
   * Sends right now or not at all — for the real-time stream (inputs, pings). Unlike `send`,
   * it never queues: an input from five seconds ago is worse than no input, and replaying a
   * backlog after a reconnect would be a burst the server would (rightly) throttle.
   * `data` is a string or a Uint8Array. Returns whether it was handed to the socket.
   */
  sendNow(data) {
    const socket = this.#socket;
    if (this.#state !== "open" || socket?.readyState !== 1) return false;
    socket.send(data);
    return true;
  }

  /** Leaving on purpose: no reconnect, the queue is discarded. */
  close(code = 1000, reason = "bye") {
    this.#intentional = true;
    clearTimeout(this.#timer);
    this.#queue.length = 0;
    const socket = this.#socket;
    if (socket && socket.readyState <= 1) socket.close(code, reason);
    else this.#finish({ code, reason, fatal: false });
  }

  #open(state) {
    this.#setState(state);
    const socket = new this.#WebSocket(this.#url);
    socket.binaryType = "arraybuffer"; // binary frames arrive as ArrayBuffer, not Blob
    this.#socket = socket;
    let gotMessage = false;

    // A connection attempt that neither opens nor fails (a SYN into the void, a NAT that
    // swallows packets) would otherwise leave us "connecting" for minutes: give up on it.
    const connectTimer = setTimeout(() => {
      if (socket !== this.#socket || socket.readyState !== 0) return;
      this.#socket = null; // from now on the abandoned socket's events are ignored
      try {
        socket.close();
      } catch {
        /* already gone */
      }
      this.#scheduleReconnect();
    }, this.#connectTimeoutMs);

    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      if (socket !== this.#socket) return;
      if (this.#handshake) socket.send(JSON.stringify(this.#handshake()));
      this.#setState("open");
      for (const queued of this.#queue.splice(0)) socket.send(JSON.stringify(queued));
    });

    socket.addEventListener("message", (event) => {
      if (socket !== this.#socket) return;
      if (typeof event.data !== "string") {
        // a binary frame: the game plane of the binary codec — not parsed here
        if (!gotMessage) {
          gotMessage = true;
          this.#attempt = 0;
        }
        const size = event.data.byteLength;
        this.dispatchEvent(new CustomEvent("frame", { detail: { size, binary: true } }));
        this.dispatchEvent(new CustomEvent("binary", { detail: event.data }));
        return;
      }
      this.dispatchEvent(
        new CustomEvent("frame", { detail: { size: event.data.length, binary: false } }),
      );
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return; // the server only sends JSON; anything else is not worth dying for
      }
      if (message === null || typeof message.type !== "string") return;
      if (!gotMessage) {
        gotMessage = true;
        this.#attempt = 0; // the server answered: this connection is healthy, forget past failures
      }
      this.dispatchEvent(new CustomEvent("message", { detail: message }));
      this.dispatchEvent(new CustomEvent(message.type, { detail: message }));
    });

    // `error` is always followed by `close`, which is where we decide what to do.
    socket.addEventListener("error", () => {});

    socket.addEventListener("close", (event) => {
      clearTimeout(connectTimer);
      if (socket !== this.#socket) return;
      this.#socket = null;
      const info = { code: event.code, reason: event.reason, fatal: isFatalClose(event.code) };
      if (this.#intentional || info.fatal) this.#finish(info);
      else this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    const delayMs = reconnectDelay(this.#attempt++, this.#backoff);
    this.#setState("reconnecting", { delayMs });
    this.#timer = setTimeout(() => this.#open("connecting"), delayMs);
  }

  #finish(info) {
    this.#queue.length = 0;
    this.#setState("closed");
    this.dispatchEvent(new CustomEvent("closed", { detail: info }));
  }

  #setState(state, extra = {}) {
    this.#state = state;
    this.dispatchEvent(
      new CustomEvent("status", { detail: { state, attempt: this.#attempt, ...extra } }),
    );
  }
}

export function wsUrl(path = "/ws", loc = globalThis.location, search = "") {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${path}${search ? `?${search}` : ""}`;
}
