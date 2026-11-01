// What a production process does about an error nobody planned for.
//
// `uncaughtException` / `unhandledRejection` mean some code path threw and nothing was
// prepared to catch it: whatever state that code was changing is now half-changed, and we do
// not know which half. Carrying on ("stay up") turns one bug into a server that is alive but
// wrong — a ship that never respawns, a room that never ticks. The professional answer is:
// write down everything, with the stack, and exit non-zero so the supervisor (Docker,
// Fly, systemd) starts a clean process. An EMPTY handler is the one thing never to write.

import type { Logger } from "./logger.ts";

/** The two things we use from `process` — so a test can pass a fake instead of the real one. */
export interface ProcessLike {
  on(event: "uncaughtException", listener: (err: Error, origin: string) => void): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  exit(code: number): unknown;
}

export function installCrashHandlers(log: Logger, proc: ProcessLike = process): void {
  proc.on("uncaughtException", (err, origin) => {
    log.fatal("uncaught exception", { origin, error: err.stack ?? String(err) });
    proc.exit(1);
  });
  proc.on("unhandledRejection", (reason) => {
    log.fatal("unhandled rejection", {
      error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    });
    proc.exit(1);
  });
}
