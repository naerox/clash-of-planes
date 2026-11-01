import type { ExplodedEvent, FiredEvent, HitEvent, SimEvent } from "@dogfight/shared";

/**
 * A tiny typed event bus. `E` maps each event name to the type of its payload, so
 * `bus.on("hit", (e) => e.damage)` knows `e` is a HitEvent, and `bus.emit("hit", 5)` is a
 * compile error. (A plain `EventTarget` would hand every listener an `Event` and leave the
 * payload as `any`.)
 *
 * `dispatch` is synchronous: listeners must stay cheap (start a sound, bump a counter). A
 * listener that throws does not stop the others — the error is re-thrown on its own
 * microtask, which is what the DOM does for `EventTarget` too.
 */
export interface Emitter<E> {
  on<K extends keyof E>(
    type: K,
    handler: (payload: E[K]) => void,
    options?: { signal?: AbortSignal; once?: boolean },
  ): void;
}

/** What happens to an error thrown by a listener: by default it surfaces as an uncaught error. */
const rethrowLater = (err: unknown): void => {
  queueMicrotask(() => {
    throw err;
  });
};

export class Bus<E> implements Emitter<E> {
  readonly #listeners: { [K in keyof E]?: Set<(payload: E[K]) => void> } = {};
  readonly #onError: (err: unknown) => void;

  constructor(onError: (err: unknown) => void = rethrowLater) {
    this.#onError = onError;
  }

  on<K extends keyof E>(
    type: K,
    handler: (payload: E[K]) => void,
    { signal, once = false }: { signal?: AbortSignal; once?: boolean } = {},
  ): void {
    if (signal?.aborted) return;
    const set = (this.#listeners[type] ??= new Set<(payload: E[K]) => void>());
    const wrapped = once
      ? (payload: E[K]): void => {
          set.delete(wrapped);
          handler(payload);
        }
      : handler;
    set.add(wrapped);
    signal?.addEventListener("abort", () => set.delete(wrapped), { once: true });
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.#listeners[type];
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err: unknown) {
        this.#onError(err);
      }
    }
  }
}

/**
 * The client's game events: what happened ("fired", "hit", "exploded") announced without
 * importing whoever listens — audio, the HUD and the particle effects subscribe from outside.
 *
 * Lab 5: the simulation runs on the server, so these events arrive INSIDE snapshots and the
 * network layer re-emits them here; the local player's own shots are announced at once, by
 * prediction.
 */
export interface GameEvents {
  fired: FiredEvent;
  hit: HitEvent;
  exploded: ExplodedEvent;
}

export type GameBus = Bus<GameEvents>;

/** Routes a simulation event to the listener list of its own type. */
export function emitSimEvent(bus: GameBus, event: SimEvent): void {
  switch (event.type) {
    case "fired":
      return bus.emit("fired", event);
    case "hit":
      return bus.emit("hit", event);
    case "exploded":
      return bus.emit("exploded", event);
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}
