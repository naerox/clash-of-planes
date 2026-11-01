// Heartbeat: one timer for all sockets. Each tick pings; every pong resets `missed`.
// A socket that has left `maxMissedPongs` pings unanswered is dead (a laptop lid, a NAT that
// forgot the mapping): TCP would not tell us for minutes, so we terminate it ourselves.
//
// Pulled out of ws.ts so it can be tested with fake timers and fake sockets: it needs nothing
// from a real WebSocketServer except "the sockets right now" and "what we remember about one".

import type { Logger } from "./logger.ts";

/** The two things the heartbeat does to a socket. */
export interface Pingable {
  ping(): void;
  terminate(): void;
}

export interface HeartbeatOptions<S extends Pingable> {
  clients: () => Iterable<S>;
  /** What we remember about a socket (its unanswered-ping count); `undefined` = not ours yet. */
  stateOf: (socket: S) => { missed: number } | undefined;
  intervalMs: number;
  maxMissedPongs: number;
  log: Logger;
}

/** Starts the timer; returns a function that stops it. */
export function startHeartbeat<S extends Pingable>({
  clients,
  stateOf,
  intervalMs,
  maxMissedPongs,
  log,
}: HeartbeatOptions<S>): () => void {
  const timer = setInterval(() => {
    for (const socket of clients()) {
      const state = stateOf(socket);
      if (!state) continue;
      if (state.missed >= maxMissedPongs) {
        log.warn("heartbeat lost", { missed: state.missed });
        socket.terminate();
        continue;
      }
      state.missed++;
      socket.ping();
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
