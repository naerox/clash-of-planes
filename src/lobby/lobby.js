// Lobby logic only — no DOM. lobbyView.js renders it; tests drive it with a fake fetch.

import { fetchJson } from "../net/http.js";
import { isAbortError, ticks } from "../async.js";

export const NAME_MAX = 16;

export function validateName(raw) {
  const name = String(raw ?? "").trim();
  if (!name) return { ok: false, error: "Введіть ім'я" };
  if (name.length > NAME_MAX) return { ok: false, error: `Ім'я — до ${NAME_MAX} символів` };
  return { ok: true, name };
}

/** Defensive parse of GET /api/rooms: the server is outside our control. */
export function parseRooms(data) {
  const list = Array.isArray(data) ? data : data?.rooms;
  if (!Array.isArray(list)) throw new TypeError("/api/rooms: очікувався масив rooms");
  return list
    .filter((r) => r && typeof r.id === "string")
    .map((r) => ({
      id: r.id,
      name: String(r.name ?? r.id),
      players: Number(r.players) || 0,
      maxPlayers: Number(r.maxPlayers) || 1,
      arena: { ...r.arena },
    }));
}

export const isFull = (room) => room.players >= room.maxPlayers;

/**
 * Events: "rooms" {rooms, at}, "status" {state: "loading"|"ok"|"error", error?},
 * "join" {name, room}. Polls only between start() and stop(); every request has its own
 * AbortSignal.timeout, and stop() aborts the request that is in flight right now.
 */
export class Lobby extends EventTarget {
  #url;
  #intervalMs;
  #timeoutMs;
  #fetchJson;
  #isVisible;
  #ac = null;
  #rooms = [];
  #inFlight = null;

  constructor({
    url = "/api/rooms",
    intervalMs = 3000,
    timeoutMs = 2500,
    fetchJson: fetcher = fetchJson,
    isVisible = () => globalThis.document?.visibilityState !== "hidden",
  } = {}) {
    super();
    this.#url = url;
    this.#intervalMs = intervalMs;
    this.#timeoutMs = timeoutMs;
    this.#fetchJson = fetcher;
    this.#isVisible = isVisible;
  }

  get rooms() {
    return this.#rooms;
  }

  get running() {
    return this.#ac !== null;
  }

  start() {
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
  stop(reason = new DOMException("Гравець залишив лобі", "AbortError")) {
    this.#ac?.abort(reason);
    this.#ac = null;
  }

  async #poll(signal) {
    try {
      for await (const tick of ticks(this.#intervalMs, signal)) {
        if (tick > 0 && !this.#isVisible()) continue; // first load always; then only if visible
        await this.refresh();
      }
    } catch (err) {
      if (!isAbortError(err)) throw err;
    }
  }

  /** One GET. Overlapping calls share the request that is already running. */
  refresh() {
    if (!this.#ac) return Promise.resolve();
    this.#inFlight ??= this.#request(this.#ac.signal).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #request(stopSignal) {
    const signal = AbortSignal.any([stopSignal, AbortSignal.timeout(this.#timeoutMs)]);
    this.#emit("status", { state: "loading" });
    try {
      // attempts: 1 — the poll interval *is* the retry; timeoutMs is ours, set just above.
      const data = await this.#fetchJson(this.#url, { signal, attempts: 1, timeoutMs: 60_000 });
      this.#rooms = parseRooms(data);
      this.#emit("rooms", { rooms: this.#rooms, at: Date.now() });
      this.#emit("status", { state: "ok" });
    } catch (err) {
      if (stopSignal.aborted) return; // we left on purpose — not an error worth showing
      const message =
        err.name === "TimeoutError"
          ? `Сервер не відповів за ${this.#timeoutMs / 1000} с`
          : (err.message ?? String(err));
      this.#emit("status", { state: "error", error: message });
    }
  }

  join(roomId, rawName) {
    const name = validateName(rawName);
    if (!name.ok) throw new RangeError(name.error);
    const room = this.#rooms.find((r) => r.id === roomId);
    if (!room) throw new RangeError("Оберіть кімнату");
    if (isFull(room)) throw new RangeError(`Кімната «${room.name}» заповнена`);
    this.stop(new DOMException("Гравець увійшов у кімнату", "AbortError"));
    this.#emit("join", { name: name.name, room });
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
