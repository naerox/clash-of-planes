import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoomError";
    this.code = code; // room_full | name_taken | too_many_rooms
  }
}

/**
 * A room knows nothing about sockets or JSON. Players are `{ id, name, send(msg, opts) }`
 * and the room only emits events:
 *
 *   "join" (player)   "leave" (player)   "chat" ({ from, text, t })   "empty" ()
 *   "event" ({ t, type, ... })  — every one of the above, shaped for the match log
 *
 * Whoever cares (the WebSocket layer, the match log) subscribes from outside.
 */
export class Room extends EventEmitter {
  players = new Map(); // id → player, in join order

  constructor({ id, name, arena, maxPlayers, now = Date.now }) {
    super();
    this.id = id;
    this.name = name;
    this.arena = arena;
    this.maxPlayers = maxPlayers;
    this.createdAt = now();
    this.now = now;
  }

  get size() {
    return this.players.size;
  }

  roster() {
    return [...this.players.values()].map(({ id, name }) => ({ id, name }));
  }

  info() {
    return {
      id: this.id,
      name: this.name,
      players: this.size,
      maxPlayers: this.maxPlayers,
      arena: this.arena,
    };
  }

  /** Throws RoomError when the room is full or the name is taken (case-insensitively). */
  join(player) {
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
  leave(player) {
    if (!this.players.delete(player.id)) return;
    this.emit("leave", player);
    this.record("leave", { player: player.id, name: player.name });
    if (this.size === 0) this.emit("empty");
  }

  chat(player, text) {
    const message = { from: { id: player.id, name: player.name }, text, t: this.now() };
    this.emit("chat", message);
    this.record("chat", { player: player.id, name: player.name, text });
    return message;
  }

  /** @param {{critical?: boolean, except?: string}} opts non-critical messages may be dropped for slow clients */
  broadcast(msg, { critical = true, except } = {}) {
    for (const p of this.players.values()) {
      if (p.id !== except) p.send(msg, { critical });
    }
  }

  record(type, data) {
    this.emit("event", { t: this.now(), room: this.id, type, ...data });
  }
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "room";

/**
 * Creates, finds and deletes rooms. A room that empties out is deleted at once; a room
 * nobody ever joins is deleted after `idleMs`, so abandoned POST /api/rooms calls cannot
 * fill the server up. Emits "created" (room) and "removed" (room).
 */
export class RoomManager extends EventEmitter {
  #rooms = new Map();
  #idleTimers = new Map();

  constructor({ maxRooms = 20, maxPlayersPerRoom = 8, idleMs = 60_000, now = Date.now } = {}) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
    this.idleMs = idleMs;
    this.now = now;
  }

  get size() {
    return this.#rooms.size;
  }

  list() {
    return [...this.#rooms.values()];
  }

  get(id) {
    return this.#rooms.get(id);
  }

  create({ name, arena, maxPlayers = this.maxPlayersPerRoom }) {
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

  delete(id, reason = "closed") {
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
  closeAll(reason = "server_shutdown") {
    for (const id of [...this.#rooms.keys()]) this.delete(id, reason);
  }
}
