import { access } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig, type ServerConfig } from "./config.ts";
import { BotManager } from "./bots.ts";
import { installCrashHandlers } from "./crash.ts";
import { createRequestListener } from "./http.ts";
import { createLogger, type Logger } from "./logger.ts";
import { MatchLogs } from "./log/matchlog.ts";
import { Metrics } from "./metrics.ts";
import { Match } from "./match.ts";
import { RoomManager } from "./rooms.ts";
import { attachBroadcast, attachWebSocket } from "./ws.ts";

/**
 * Builds the whole server without listening yet, so tests (and `main` below) can start it
 * on any port. Wiring is explicit: the RoomManager emits "created"/"removed", and the
 * WebSocket broadcast and the match log each subscribe from outside.
 */
export function createApp(
  config: ServerConfig,
  log: Logger = createLogger({ level: config.logLevel }),
  { processMetrics = false }: { processMetrics?: boolean } = {},
) {
  const metrics = new Metrics({
    version: config.version,
    gitSha: config.gitSha,
    processMetrics,
  });
  let draining = false; // set the moment shutdown begins: /ready turns 503 before anything closes
  const rooms = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
    idleMs: config.roomIdleMs,
  });
  const logs = new MatchLogs({
    dir: config.logDir,
    onError: (err, file) => log.error("match log failed", { file, error: err.message }),
  });

  rooms.on("created", (room) => {
    // ORDER MATTERS: the match must hear "join" before the broadcast does, because it is the
    // match that gives the player a ship — and the roster that is broadcast carries ship ids.
    const match = new Match({
      room,
      log: log.child({ roomId: room.id }),
      inputReserve: config.inputReserve,
      onTick: (ms) => metrics.tickDuration.observe(ms / 1000),
    });
    room.match = match;
    room.on("join", (player) => match.addPlayer(player));
    room.on("leave", (player) => match.removePlayer(player));
    attachBroadcast(room);
    logs.attach(room);
  });
  rooms.on("removed", (room) => {
    log.info("room removed", { roomId: room.id });
    room.match?.stop();
    void logs.detach(room); // its errors go to `onError`; nothing waits on this one
  });

  const bots = new BotManager();
  const playerCount = (): number => rooms.list().reduce((n, r) => n + r.size, 0);
  // the index page is what a visitor needs first: without it we are alive but not useful
  const indexPage = join(config.clientDist, "index.html");
  const readiness = async (): Promise<{ ready: boolean; reason?: string }> => {
    if (draining) return { ready: false, reason: "shutting down" };
    try {
      await access(indexPage);
    } catch {
      return { ready: false, reason: "client build not found" };
    }
    return { ready: true };
  };
  const server = createServer(
    createRequestListener({ config, rooms, bots, log, metrics, readiness, players: playerCount }),
  );
  server.on("clientError", (err, socket) => {
    // a malformed request: answer 400 and close, never throw
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    log.warn("client error", { error: err.message });
  });
  const ws = attachWebSocket({ server, rooms, config, log, metrics });
  metrics.observe({
    rooms: () => rooms.size,
    players: playerCount,
    connections: () => ws.clients,
    tickP99Ms: () =>
      Math.max(0, ...rooms.list().map((r) => r.match?.stats.duration.summary().p99 ?? 0)),
  });

  let closing: Promise<void> | null = null;
  return {
    config,
    server,
    rooms,
    bots,
    logs,
    ws,
    metrics,
    readiness,
    listen(): Promise<AddressInfo> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("the server is not listening on a TCP port"));
          } else resolve(address);
        });
      });
    },
    /**
     * Graceful shutdown: stop accepting → tell sockets 1001 → drop rooms (each match log gets
     * its last line) → wait until every log file is flushed and closed.
     */
    shutdown(): Promise<void> {
      closing ??= (async () => {
        draining = true;
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeIdleConnections();
        await ws.close();
        rooms.closeAll();
        await logs.closeAll();
        // a download still in flight would keep `server.close` pending: give it the grace
        // period, then cut it
        const timer = setTimeout(() => server.closeAllConnections(), config.shutdownGraceMs);
        await stopped;
        clearTimeout(timer);
      })();
      return closing;
    },
  };
}

async function main(): Promise<void> {
  let config: ServerConfig;
  try {
    config = loadConfig();
  } catch (err: unknown) {
    if (!(err instanceof ConfigError)) throw err;
    // the logger needs a valid config for its level, so this one line is printed by hand
    console.error(err.message);
    process.exit(2);
  }
  const log = createLogger({
    level: config.logLevel,
    base: { version: config.version, sha: config.gitSha },
  });

  installCrashHandlers(log); // an error nobody planned for: log it with the stack and exit 1

  const app = createApp(config, log, { processMetrics: true });
  const address = await app.listen();
  log.info("listening", {
    url: `http://${address.address}:${address.port}`,
    logDir: config.logDir,
    allowedOrigins: config.allowedOrigins,
    maxConnectionsPerIp: config.maxConnectionsPerIp,
  });

  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      void shutdownOn(signal);
    });
  }

  async function shutdownOn(signal: string): Promise<void> {
    if (shuttingDown) {
      log.warn("second signal, exiting now", { signal });
      process.exit(1);
    }
    shuttingDown = true;
    log.info("shutting down", { signal });
    // the supervisor's patience is finite (docker stop: 10 s, then SIGKILL): do not outlast it
    const hardStop = setTimeout(() => {
      log.error("shutdown took too long, exiting", { afterMs: HARD_STOP_MS });
      process.exit(1);
    }, HARD_STOP_MS);
    hardStop.unref();
    try {
      await app.shutdown();
      log.info("bye");
      process.exit(0);
    } catch (err: unknown) {
      log.error("shutdown failed", { error: err instanceof Error ? err.stack : String(err) });
      process.exit(1);
    }
  }
}

/** Always less than the 10 s `docker stop` waits before SIGKILL. */
const HARD_STOP_MS = 8000;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
