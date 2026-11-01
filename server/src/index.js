import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig } from "./config.js";
import { createRequestListener } from "./http.js";
import { createLogger } from "./logger.js";
import { MatchLogs } from "./log/matchlog.js";
import { RoomManager } from "./rooms.js";
import { attachBroadcast, attachWebSocket } from "./ws.js";

/**
 * Builds the whole server without listening yet, so tests (and `main` below) can start it
 * on any port. Wiring is explicit: the RoomManager emits "created"/"removed", and the
 * WebSocket broadcast and the match log each subscribe from outside.
 */
export function createApp(config, log = createLogger()) {
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
    attachBroadcast(room);
    logs.attach(room);
  });
  rooms.on("removed", (room) => {
    log.info("room removed", { room: room.id });
    logs.detach(room);
  });

  const server = createServer(createRequestListener({ config, rooms, log }));
  server.on("clientError", (err, socket) => {
    // a malformed request: answer 400 and close, never throw
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    log.warn("client error", { error: err.message });
  });
  const ws = attachWebSocket({ server, rooms, config, log });

  let closing = null;
  return {
    config,
    server,
    rooms,
    logs,
    ws,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    /**
     * Graceful shutdown: stop accepting → tell sockets 1001 → drop rooms (each match log gets
     * its last line) → wait until every log file is flushed and closed.
     */
    shutdown() {
      closing ??= (async () => {
        const stopped = new Promise((resolve) => server.close(resolve));
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

async function main() {
  const log = createLogger();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    process.exit(2);
  }

  const app = createApp(config, log);
  const address = await app.listen();
  log.info("listening", {
    url: `http://${address.address}:${address.port}`,
    logDir: config.logDir,
  });

  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      if (shuttingDown) {
        log.warn("second signal, exiting now", { signal });
        process.exit(1);
      }
      shuttingDown = true;
      log.info("shutting down", { signal });
      try {
        await app.shutdown();
        log.info("bye");
        process.exit(0);
      } catch (err) {
        log.error("shutdown failed", { error: err.stack });
        process.exit(1);
      }
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
