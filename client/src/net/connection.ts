// A WebSocket that survives the network: a send queue while there is no open socket, and
// reconnection with exponentially growing, jittered pauses (Lab 3's retry idea, again).
//
//   idle ──connect()──► connecting ──open──► open ──close (non-fatal)──► reconnecting ─┐
//                           ▲                  │                                       │
//                           └──────────────────┴───────────── timer fires ◄────────────┘
//   any state ──close() / fatal close code──► closed
//
// Events (typed: see `ConnectionEvents`; subscribe with `connection.on(name, handler)`):
//   "status"  { state, attempt, delayMs? }   every state change
//   "message" the parsed server message      and the same payload under its own `type`
//                                            ("joined", "roster", "chat", "error", …;
//                                            in JSON mode also "snapshot" and "pong")
//   "binary"  ArrayBuffer                    a binary frame (the binary codec's snapshots, pongs)
//   "frame"   { size, binary }               every frame that arrived, for bandwidth statistics
//   "closed"  { code, reason, fatal }        final: the connection will not come back
//
// Everything that arrives is `unknown` until the shared Zod schemas have checked it: a text
// frame that is not a valid server message is dropped, never dispatched half-typed.
//
// `handshake()` returns the message that must open every connection (the `join`). It is sent
// first on every (re)connect — the server forgot us when the old socket died — and only then
// is the queue flushed, so queued chat lines arrive after the rejoin, in order.

import { parseServerMessage, type ServerMessage } from "@dogfight/shared";
import { Bus } from "../events.ts";
import { isFatalClose, type ControlOut } from "./protocol.ts";

/** "Equal jitter": half of the exponential step is fixed, half is random. Unlike full jitter
 * it never returns ~0, so a flapping server is not hammered in a tight loop. */
export function reconnectDelay(
  attempt: number,
  {
    baseMs = 500,
    capMs = 10_000,
    random = Math.random,
  }: { baseMs?: number; capMs?: number; random?: () => number } = {},
): number {
  const step = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(step / 2 + (random() * step) / 2);
}

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface StatusInfo {
  readonly state: ConnectionState;
  readonly attempt: number;
  readonly delayMs?: number;
}

export interface CloseInfo {
  readonly code: number;
  readonly reason: string;
  readonly fatal: boolean;
}

export interface FrameInfo {
  readonly size: number;
  readonly binary: boolean;
}

/**
 * Every event a Connection emits, by name. The per-message-type entries are DERIVED from the
 * `ServerMessage` union (a mapped type with key remapping): add a message to the protocol and
 * the connection grows an event for it, with the right payload type, without a line of code.
 */
export type ConnectionEvents = {
  status: StatusInfo;
  message: ServerMessage;
  binary: ArrayBuffer;
  frame: FrameInfo;
  closed: CloseInfo;
} & { [M in ServerMessage as M["type"]]: M };

/** The slice of a WebSocket the Connection uses — so a test can hand it a fake. */
export interface SocketEvents {
  open: unknown;
  message: { readonly data: unknown };
  error: unknown;
  close: { readonly code: number; readonly reason: string };
}

export interface SocketLike {
  binaryType: BinaryType;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof SocketEvents>(
    type: K,
    listener: (event: SocketEvents[K]) => void,
  ): void;
}

export type SocketFactory = new (url: string) => SocketLike;

export interface ConnectionOptions {
  url: string;
  handshake?: (() => ControlOut) | null;
  WebSocketImpl?: SocketFactory;
  backoff?: { baseMs?: number; capMs?: number; random?: () => number };
  maxQueue?: number;
  connectTimeoutMs?: number;
}

export class Connection extends Bus<ConnectionEvents> {
  readonly #url: string;
  readonly #handshake: (() => ControlOut) | null;
  readonly #WebSocket: SocketFactory;
  readonly #backoff: NonNullable<ConnectionOptions["backoff"]>;
  readonly #maxQueue: number;
  readonly #connectTimeoutMs: number;
  #socket: SocketLike | null = null;
  #queue: ControlOut[] = [];
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #state: ConnectionState = "idle";
  #intentional = false;

  constructor({
    url,
    handshake = null,
    WebSocketImpl = WebSocket,
    backoff = {},
    maxQueue = 100,
    connectTimeoutMs = 8000,
  }: ConnectionOptions) {
    super();
    this.#url = url;
    this.#handshake = handshake;
    this.#WebSocket = WebSocketImpl;
    this.#backoff = backoff;
    this.#maxQueue = maxQueue;
    this.#connectTimeoutMs = connectTimeoutMs;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get queued(): number {
    return this.#queue.length;
  }

  connect(): void {
    if (this.#state !== "idle") return;
    this.#intentional = false;
    this.#open("connecting");
  }

  /** Sends now if the socket is open, otherwise queues. Returns false only if the queue is full. */
  send(message: ControlOut): boolean {
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
  sendNow(data: string | Uint8Array): boolean {
    const socket = this.#socket;
    if (this.#state !== "open" || socket?.readyState !== 1) return false;
    socket.send(data);
    return true;
  }

  /** Leaving on purpose: no reconnect, the queue is discarded. */
  close(code = 1000, reason = "bye"): void {
    this.#intentional = true;
    clearTimeout(this.#timer);
    this.#queue.length = 0;
    const socket = this.#socket;
    if (socket && socket.readyState <= 1) socket.close(code, reason);
    else this.#finish({ code, reason, fatal: false });
  }

  #open(state: ConnectionState): void {
    this.#setState(state);
    const socket = new this.#WebSocket(this.#url);
    socket.binaryType = "arraybuffer"; // binary frames arrive as ArrayBuffer, not Blob
    this.#socket = socket;
    let gotMessage = false;
    const healthy = (): void => {
      if (gotMessage) return;
      gotMessage = true;
      this.#attempt = 0; // the server answered: this connection is healthy, forget past failures
    };

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
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        // a binary frame: the game plane of the binary codec — decoded (and checked) by the session
        healthy();
        this.emit("frame", { size: data.byteLength, binary: true });
        this.emit("binary", data);
        return;
      }
      if (typeof data !== "string") return; // a Blob or something else we never asked for
      this.emit("frame", { size: data.length, binary: false });
      const parsed = parseServerMessage(data);
      if (!parsed.ok) return; // the server only sends valid JSON; anything else is not worth dying for
      healthy();
      this.emit("message", parsed.msg);
      this.emit(parsed.msg.type, parsed.msg);
    });

    // `error` is always followed by `close`, which is where we decide what to do.
    socket.addEventListener("error", () => {});

    socket.addEventListener("close", (event) => {
      clearTimeout(connectTimer);
      if (socket !== this.#socket) return;
      this.#socket = null;
      const info: CloseInfo = {
        code: event.code,
        reason: event.reason,
        fatal: isFatalClose(event.code),
      };
      if (this.#intentional || info.fatal) this.#finish(info);
      else this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(): void {
    const delayMs = reconnectDelay(this.#attempt++, this.#backoff);
    this.#setState("reconnecting", { delayMs });
    this.#timer = setTimeout(() => this.#open("connecting"), delayMs);
  }

  #finish(info: CloseInfo): void {
    this.#queue.length = 0;
    this.#setState("closed");
    this.emit("closed", info);
  }

  #setState(state: ConnectionState, extra: { delayMs?: number } = {}): void {
    this.#state = state;
    this.emit("status", { state, attempt: this.#attempt, ...extra });
  }
}

export function wsUrl(
  path = "/ws",
  loc: { protocol: string; host: string } = globalThis.location,
  search = "",
): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${path}${search ? `?${search}` : ""}`;
}
