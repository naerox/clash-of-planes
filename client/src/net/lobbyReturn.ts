// When the server goes away in the middle of a match.
//
// A deploy, a crash or a restart takes every room with it: rooms live in one process's memory.
// The Connection already reconnects with backoff (and re-sends `join`), which is exactly right
// for a network blip — but after a restart the room no longer exists, and if the server stays
// down the player would stare at a frozen arena forever. So this watcher decides when to give
// up and send the player back to the lobby WITH A REASON:
//
//   server said "shutdown", then reconnects fail for `giveUpAfterMs`   → "restarting, not back yet"
//   server never answers for `giveUpAfterMs`                          → "server unavailable"
//   server came back but has no such room (a fresh process)           → "restarted, the room is gone"
//   any other final close                                             → "connection lost (code …)"
//
// Pure logic around a Bus, so it is tested with fake timers and no browser.

import type { Emitter } from "../events.ts";
import type { ConnectionEvents } from "./connection.ts";
import { describeClose } from "./protocol.ts";

export type WatchedEvents = Pick<ConnectionEvents, "status" | "closed" | "shutdown" | "error">;

export interface LossOptions {
  /** How long the connection may stay down before the player is sent back to the lobby. */
  giveUpAfterMs?: number;
  /** Called once, with the sentence to show in the lobby. */
  onLost: (reason: string) => void;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Starts watching; returns a function that stops (the game is over, or the page is leaving). */
export function watchForLoss(
  connection: Emitter<WatchedEvents>,
  { giveUpAfterMs = 15_000, onLost, setTimer = setTimeout, clearTimer = clearTimeout }: LossOptions,
): () => void {
  const stop = new AbortController();
  const { signal } = stop;
  let serverSaidBye = false;
  let lastServerError: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;

  const lose = (reason: string): void => {
    if (done) return;
    done = true;
    stop.abort();
    if (timer !== null) clearTimer(timer);
    onLost(reason);
  };

  connection.on("shutdown", () => (serverSaidBye = true), { signal });
  connection.on("error", (e) => (lastServerError = e.code), { signal });
  connection.on(
    "status",
    ({ state }) => {
      if (state === "open") {
        // a healthy socket again: stop the countdown (a fatal close would still arrive as "closed")
        if (timer !== null) clearTimer(timer);
        timer = null;
      } else if ((state === "reconnecting" || state === "connecting") && timer === null) {
        timer = setTimer(
          () =>
            lose(
              serverSaidBye
                ? "Сервер перезапускається і ще не відповідає — ви повернулися в лобі."
                : "Сервер недоступний — ви повернулися в лобі.",
            ),
          giveUpAfterMs,
        );
      }
    },
    { signal },
  );
  connection.on(
    "closed",
    ({ code }) => {
      if (lastServerError === "no_such_room")
        return lose("Сервер перезапустився, і кімнати вже немає. Оберіть кімнату знову.");
      lose(`З'єднання втрачено (${describeClose(code)}). Оберіть кімнату знову.`);
    },
    { signal },
  );
  return () => {
    done = true;
    stop.abort();
    if (timer !== null) clearTimer(timer);
  };
}
