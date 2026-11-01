import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  AnyCodec,
  ArenaConfig,
  EntityId,
  GameMessage,
  RosterEntry,
  ServerControl,
  SnapshotMessage,
  WithVersion,
  RoomInfo,
} from "@dogfight/shared";
import type { Match } from "./match.ts";

export type RoomErrorCode = "room_full" | "name_taken" | "too_many_rooms";

export class RoomError extends Error {
  readonly code: RoomErrorCode;

  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

/** A control message exactly as it goes on the wire: `{ v, type, … }`. */
export type ControlFrame = WithVersion<ServerControl>;

export interface SendOptions {
  /** Non-critical messages may be dropped for a slow client. */
  critical?: boolean;
}

/**
 * Who sits in a room. The room knows nothing about sockets or JSON: a player is whatever can
 * be sent to. The WebSocket layer builds one per connection; tests build plain ones.
 */
export interface Player {
  readonly id: string;
  readonly name: string;
  readonly codec: AnyCodec;
  /** The ship the match gave this player while handling "join". */
  shipId: EntityId | null;
  /** Control messages: JSON text, through the connection's queue and the slow-client policy. */
  send(message: ControlFrame, options?: SendOptions): boolean;
  /** A snapshot, encoded in this connection's codec. Returns the encoded size in bytes. */
  deliver(snapshot: SnapshotMessage): number;
  /** A pong (or any other codec-level game message). */
  deliverControl(message: GameMessage): void;
  /** Cut this player off (a flood, say). */
  kick(reason: string): void;
}

export interface ChatMessage {
  readonly from: { readonly id: string; readonly name: string };
  readonly text: string;
  readonly t: number;
}

/** One line of the match log: when, which room, what, plus whatever the event carries. */
export interface RoomLogEntry {
  readonly t: number;
  readonly room: string;
  readonly type: string;
  readonly [field: string]: unknown;
}

/**
 * The events a Room emits, and what each carries. `room.on("chat", (m) => …)` knows `m` is a
 * ChatMessage, and `room.emit("chat", 42)` does not compile.
 *
 *   "join" (player)   "leave" (player)   "chat" ({ from, text, t })   "empty" ()
 *   "event" ({ t, room, type, ... })  — every one of the above, shaped for the match log
 */
export type RoomEvents = {
  join: [player: Player];
  leave: [player: Player];
  chat: [message: ChatMessage];
  empty: [];
  event: [entry: RoomLogEntry];
};

export interface RoomOptions {
  id: string;
  name: string;
  arena: ArenaConfig;
  maxPlayers: number;
  now?: () => number;
}

/**
 * A room knows nothing about sockets or JSON. Whoever cares (the WebSocket layer, the match
 * log) subscribes from outside.
 */
export class Room extends EventEmitter<RoomEvents> {
  readonly players = new Map<string, Player>(); // id → player, in join order
  /** The authoritative simulation for this room (match.ts), set by the app. */
  match: Match | null = null;
  readonly id: string;
  readonly name: string;
  readonly arena: ArenaConfig;
  readonly maxPlayers: number;
  readonly createdAt: number;
  readonly now: () => number;

  constructor({ id, name, arena, maxPlayers, now = Date.now }: RoomOptions) {
    super();
    this.id = id;
    this.name = name;
    this.arena = arena;
    this.maxPlayers = maxPlayers;
    this.createdAt = now();
    this.now = now;
  }

  get size(): number {
    return this.players.size;
  }

  roster(): RosterEntry[] {
    return [...this.players.values()].map(({ id, name, shipId }) => ({ id, name, shipId }));
  }

  info(): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      players: this.size,
      maxPlayers: this.maxPlayers,
      arena: this.arena,
    };
  }

  /** Throws RoomError when the room is full or the name is taken (case-insensitively). */
  join(player: Player): void {
    if (this.size >= this.maxPlayers) throw new RoomError("room_full", "room is full");
    const lower = player.name.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower)
        throw new RoomError("name_taken", "name is already taken");
    }
    this.players.set(player.id, player);
    this.emit("join", player);
    this.record("join", { player: player.id, name: player.name });
  }

  /** Idempotent: a socket may close twice (error, then close). */
  leave(player: Player): void {
    if (!this.players.delete(player.id)) return;
    this.emit("leave", player);
    this.record("leave", { player: player.id, name: player.name });
    if (this.size === 0) this.emit("empty");
  }

  chat(player: Player, text: string): ChatMessage {
    const message: ChatMessage = {
      from: { id: player.id, name: player.name },
      text,
      t: this.now(),
    };
    this.emit("chat", message);
    this.record("chat", { player: player.id, name: player.name, text });
    return message;
  }

  /** Non-critical messages may be dropped for slow clients. */
  broadcast(
    msg: ControlFrame,
    { critical = true, except }: { critical?: boolean; except?: string } = {},
  ): void {
    for (const p of this.players.values()) {
      if (p.id !== except) p.send(msg, { critical });
    }
  }

  record(type: string, data: Readonly<Record<string, unknown>> = {}): void {
    this.emit("event", { t: this.now(), room: this.id, type, ...data });
  }
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "room";

export type ManagerEvents = {
  created: [room: Room];
  removed: [room: Room];
};

export interface ManagerOptions {
  maxRooms?: number;
  maxPlayersPerRoom?: number;
  idleMs?: number;
  now?: () => number;
}

export interface CreateRoomOptions {
  name: string;
  arena: ArenaConfig;
  maxPlayers?: number;
}

/**
 * Creates, finds and deletes rooms. A room that empties out is deleted at once; a room
 * nobody ever joins is deleted after `idleMs`, so abandoned POST /api/rooms calls cannot
 * fill the server up. Emits "created" (room) and "removed" (room).
 */
export class RoomManager extends EventEmitter<ManagerEvents> {
  #rooms = new Map<string, Room>();
  #idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;
  readonly idleMs: number;
  readonly now: () => number;

  constructor({
    maxRooms = 20,
    maxPlayersPerRoom = 8,
    idleMs = 60_000,
    now = Date.now,
  }: ManagerOptions = {}) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
    this.idleMs = idleMs;
    this.now = now;
  }

  get size(): number {
    return this.#rooms.size;
  }

  list(): Room[] {
    return [...this.#rooms.values()];
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id);
  }

  create({ name, arena, maxPlayers = this.maxPlayersPerRoom }: CreateRoomOptions): Room {
    if (this.#rooms.size >= this.maxRooms) {
      throw new RoomError("too_many_rooms", `server is limited to ${this.maxRooms} rooms`);
    }
    const id = `${slug(name)}-${randomUUID().slice(0, 4)}`;
    const room = new Room({
      id,
      name,
      arena,
      maxPlayers: Math.min(maxPlayers, this.maxPlayersPerRoom),
      now: this.now,
    });
    this.#rooms.set(id, room);

    // "empty" is emitted by the room itself; the manager is just one more listener.
    room.once("empty", () => this.delete(id, "empty"));
    room.once("join", () => clearTimeout(this.#idleTimers.get(id)));
    const timer = setTimeout(() => {
      if (room.size === 0) this.delete(id, "idle");
    }, this.idleMs);
    timer.unref();
    this.#idleTimers.set(id, timer);

    this.emit("created", room);
    room.record("room_opened", { name, arena, maxPlayers: room.maxPlayers });
    return room;
  }

  delete(id: string, reason = "closed"): boolean {
    const room = this.#rooms.get(id);
    if (!room) return false;
    clearTimeout(this.#idleTimers.get(id));
    this.#idleTimers.delete(id);
    this.#rooms.delete(id);
    room.record("room_closed", { reason });
    this.emit("removed", room);
    return true;
  }

  /** Server shutdown: drop every room (their match logs get a final line). */
  closeAll(reason = "server_shutdown"): void {
    for (const id of [...this.#rooms.keys()]) this.delete(id, reason);
  }
}
