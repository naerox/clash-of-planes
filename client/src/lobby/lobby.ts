// Lobby logic only — no DOM. lobbyView.js renders it; tests drive it with a fake fetch.

import { roomInfoSchema, roomListSchema, type RoomInfo } from "@dogfight/shared";
import { isAbortError, ticks } from "../async.ts";
import { Bus } from "../events.ts";
import { fetchJson, type FetchJson } from "../net/http.ts";

export const NAME_MAX = 16;

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

export function validateName(raw: string | null | undefined): NameCheck {
  const name = (raw ?? "").trim();
  if (!name) return { ok: false, error: "Введіть ім'я" };
  if (name.length > NAME_MAX) return { ok: false, error: `Ім'я — до ${NAME_MAX} символів` };
  return { ok: true, name };
}

/**
 * `GET /api/rooms`: the server is outside our control, so the body is `unknown` until the
 * shared schema has checked it. A wrong shape throws a ZodError that names the bad field.
 */
export function parseRooms(data: unknown): RoomInfo[] {
  return roomListSchema.parse(data).rooms;
}

export const isFull = (room: RoomInfo): boolean => room.players >= room.maxPlayers;

/**
 * Events (typed, see `LobbyEvents`): "rooms", "status", "created", "join". Polls only between
 * start() and stop(); every request has its own AbortSignal.timeout, and stop() aborts the
 * request that is in flight right now.
 */
export type LobbyEvents = {
  rooms: { rooms: RoomInfo[]; at: number };
  status: { state: "loading" | "ok" | "error"; error?: string };
  created: { room: RoomInfo };
  join: { name: string; room: RoomInfo };
};

export interface LobbyOptions {
  url?: string;
  intervalMs?: number;
  timeoutMs?: number;
  fetchJson?: FetchJson;
  isVisible?: () => boolean;
}

export class Lobby extends Bus<LobbyEvents> {
  readonly #url: string;
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  readonly #fetchJson: FetchJson;
  readonly #isVisible: () => boolean;
  #ac: AbortController | null = null;
  #rooms: RoomInfo[] = [];
  #inFlight: Promise<void> | null = null;

  constructor({
    url = "/api/rooms",
    intervalMs = 3000,
    timeoutMs = 2500,
    fetchJson: fetcher = fetchJson,
    isVisible = () => globalThis.document?.visibilityState !== "hidden",
  }: LobbyOptions = {}) {
    super();
    this.#url = url;
    this.#intervalMs = intervalMs;
    this.#timeoutMs = timeoutMs;
    this.#fetchJson = fetcher;
    this.#isVisible = isVisible;
  }

  get rooms(): readonly RoomInfo[] {
    return this.#rooms;
  }

  get running(): boolean {
    return this.#ac !== null;
  }

  start(): void {
    if (this.#ac) return;
    this.#ac = new AbortController();
    const { signal } = this.#ac;
    // A hidden tab skips its polls; coming back refreshes at once instead of waiting.
    globalThis.document?.addEventListener(
      "visibilitychange",
      () => this.#isVisible() && this.refresh(),
      { signal },
    );
    this.#poll(signal);
  }

  /** Leaving the lobby: no more ticks, and the in-flight request is cancelled now. */
  stop(reason: unknown = new DOMException("Гравець залишив лобі", "AbortError")): void {
    this.#ac?.abort(reason);
    this.#ac = null;
  }

  async #poll(signal: AbortSignal): Promise<void> {
    try {
      for await (const tick of ticks(this.#intervalMs, signal)) {
        if (tick > 0 && !this.#isVisible()) continue; // first load always; then only if visible
        await this.refresh();
      }
    } catch (err: unknown) {
      if (!isAbortError(err)) throw err;
    }
  }

  /** One GET. Overlapping calls share the request that is already running. */
  refresh(): Promise<void> {
    if (!this.#ac) return Promise.resolve();
    this.#inFlight ??= this.#request(this.#ac.signal).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #request(stopSignal: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([stopSignal, AbortSignal.timeout(this.#timeoutMs)]);
    this.emit("status", { state: "loading" });
    try {
      // attempts: 1 — the poll interval *is* the retry; timeoutMs is ours, set just above.
      const data = await this.#fetchJson(this.#url, { signal, attempts: 1, timeoutMs: 60_000 });
      this.#rooms = parseRooms(data);
      this.emit("rooms", { rooms: this.#rooms, at: Date.now() });
      this.emit("status", { state: "ok" });
    } catch (err: unknown) {
      if (stopSignal.aborted) return; // we left on purpose — not an error worth showing
      const message =
        err instanceof Error && err.name === "TimeoutError"
          ? `Сервер не відповів за ${this.#timeoutMs / 1000} с`
          : err instanceof Error
            ? err.message
            : String(err);
      this.emit("status", { state: "error", error: message });
    }
  }

  /** POST /api/rooms. Resolves with the created room (the server picks its id); rejects with
   * the server's own message (409 "server is limited to 20 rooms", 400 validation, …). */
  async createRoom(request: {
    name: string;
    arena: RoomInfo["arena"];
    maxPlayers?: number;
  }): Promise<RoomInfo> {
    const { name, arena, maxPlayers } = request;
    const body = JSON.stringify({ name, arena, maxPlayers });
    const created = await this.#fetchJson(this.#url, {
      signal: AbortSignal.timeout(this.#timeoutMs * 2),
      attempts: 1, // not idempotent: a retried POST could create two rooms
      timeoutMs: 60_000,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body },
    });
    const room = roomInfoSchema.parse(created);
    this.#rooms = [...this.#rooms.filter((r) => r.id !== room.id), room];
    this.emit("rooms", { rooms: this.#rooms, at: Date.now() });
    this.emit("created", { room });
    return room;
  }

  join(roomId: string, rawName: string): void {
    const name = validateName(rawName);
    if (!name.ok) throw new RangeError(name.error);
    const room = this.#rooms.find((r) => r.id === roomId);
    if (!room) throw new RangeError("Оберіть кімнату");
    if (isFull(room)) throw new RangeError(`Кімната «${room.name}» заповнена`);
    this.stop(new DOMException("Гравець увійшов у кімнату", "AbortError"));
    this.emit("join", { name: name.name, room });
  }
}
