// The HTTP layer, on bare `node:http`: a router of about ten lines, a capped body reader and
// JSON helpers. (Fastify/Express would hide all of this — the Stretch asks what exactly.)

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { MIME, PathError, safeRelativePath, serveStatic } from "./static.js";
import { listReplays, replayPath } from "./log/replay.js";
import { TICK_RATE, hasControl } from "@dogfight/shared";
import { RoomError } from "./rooms.js";

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(text);
}

/** Collects a JSON body, refusing anything larger than `maxBytes` (413) or not JSON (400). */
export async function readJsonBody(req, maxBytes) {
  const declared = Number(req.headers["content-length"]);
  if (declared > maxBytes) throw new HttpError(413, `body is limited to ${maxBytes} bytes`);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, `body is limited to ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** Validates the body of POST /api/rooms; returns a clean `{ name, arena, maxPlayers }`. */
export function parseRoomRequest(body, { maxPlayersPerRoom }) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 32 || hasControl(name)) {
    throw new HttpError(400, "name must be 1–32 printable characters");
  }
  const a = body.arena ?? {};
  const arena = {
    asteroids: a.asteroids ?? 4,
    hunters: a.hunters ?? 1,
    asteroidSpeed: a.asteroidSpeed ?? [40, 100],
  };
  const [lo, hi] = Array.isArray(arena.asteroidSpeed) ? arena.asteroidSpeed : [];
  if (!isInt(arena.asteroids, 0, 20)) throw new HttpError(400, "arena.asteroids must be 0–20");
  if (!isInt(arena.hunters, 0, 6)) throw new HttpError(400, "arena.hunters must be 0–6");
  if (!(isInt(lo, 0, 400) && isInt(hi, 0, 400) && lo <= hi)) {
    throw new HttpError(400, "arena.asteroidSpeed must be [min, max] within 0–400");
  }
  const maxPlayers = body.maxPlayers ?? maxPlayersPerRoom;
  if (!isInt(maxPlayers, 1, maxPlayersPerRoom)) {
    throw new HttpError(400, `maxPlayers must be 1–${maxPlayersPerRoom}`);
  }
  return { name, arena, maxPlayers };
}

export function createRequestListener({ config, rooms, log }) {
  async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    if (pathname === "/health") {
      if (method !== "GET") throw new HttpError(405, "method not allowed", { Allow: "GET" });
      return sendJson(res, 200, {
        status: "ok",
        uptime: Math.round(process.uptime()),
        rooms: rooms.size,
        rss: process.memoryUsage.rss(),
      });
    }

    if (pathname === "/api/rooms") {
      if (method === "GET") {
        return sendJson(res, 200, { rooms: rooms.list().map((r) => r.info()) });
      }
      if (method === "POST") {
        const request = parseRoomRequest(await readJsonBody(req, config.maxBodyBytes), config);
        try {
          const room = rooms.create(request);
          return sendJson(res, 201, room.info(), { Location: `/api/rooms/${room.id}` });
        } catch (err) {
          if (err instanceof RoomError) throw new HttpError(409, err.message);
          throw err;
        }
      }
      throw new HttpError(405, "method not allowed", { Allow: "GET, POST" });
    }

    if (pathname === "/api/stats" && method === "GET") {
      return sendJson(res, 200, {
        tickRate: TICK_RATE,
        uptime: Math.round(process.uptime()),
        rssBytes: process.memoryUsage.rss(),
        netsim: config.netsim,
        matches: rooms
          .list()
          .map((r) => r.match?.summary())
          .filter(Boolean),
      });
    }

    if (pathname === "/api/replays" && method === "GET") {
      return sendJson(res, 200, { replays: await listReplays(config.logDir) });
    }

    const replay = /^\/api\/replays\/([^/]+)$/.exec(pathname);
    if (replay && method === "GET") return streamReplay(res, replay[1]);

    if (config.debugRoutes) {
      // Lab 4, M4 demos — never enabled by default.
      if (pathname === "/api/slow") {
        const ms = Math.min(Number(url.searchParams.get("ms")) || 300, 5000);
        const end = performance.now() + ms;
        while (performance.now() < end); // blocks the event loop on purpose
        return sendJson(res, 200, { blockedMs: ms });
      }
      const naive = /^\/api\/replays-naive\/([^/]+)$/.exec(pathname);
      if (naive) return naiveReplay(res, naive[1]);
    }

    if (pathname.startsWith("/api/")) throw new HttpError(404, "no such endpoint");
    const relative = safeRelativePath(req.url);
    return serveStatic(req, res, { root: config.clientDist, relative });
  }

  async function streamReplay(res, id) {
    const file = replayPath(config.logDir, id);
    const info = file && (await stat(file).catch(() => null));
    if (!info?.isFile()) throw new HttpError(404, "no such replay");
    res.writeHead(200, {
      "Content-Type": MIME[".ndjson"],
      "Content-Length": info.size,
      "Content-Disposition": `attachment; filename="${id}.ndjson"`,
    });
    // The file flows disk → socket in 64 KiB chunks; when the client reads slowly,
    // `res.write` returns false, pipeline pauses the file stream, and memory stays flat.
    await pipeline(createReadStream(file), res);
  }

  /** The anti-pattern, for the RSS comparison: the whole file in memory, then one write. */
  async function naiveReplay(res, id) {
    const file = replayPath(config.logDir, id);
    if (!file) throw new HttpError(404, "no such replay");
    const data = await readFile(file).catch(() => null);
    if (!data) throw new HttpError(404, "no such replay");
    res.writeHead(200, { "Content-Type": MIME[".ndjson"], "Content-Length": data.length });
    res.end(data);
  }

  return async function onRequest(req, res) {
    res.on("error", (err) => log.warn("response error", { error: err.message }));
    req.on("error", (err) => log.warn("request error", { error: err.message }));
    try {
      let url;
      try {
        url = new URL(req.url, "http://localhost");
      } catch {
        throw new HttpError(400, "malformed request target");
      }
      safeRelativePath(req.url); // `..` anywhere — API or static — is refused up front
      await route(req, res, url);
    } catch (err) {
      // the client hung up mid-download (a slow reader giving up): nothing to answer, not an error
      if (err.code === "ERR_STREAM_PREMATURE_CLOSE" || res.destroyed) return;
      const status = err instanceof HttpError || err instanceof PathError ? err.status : 500;
      if (status === 500) log.error("request failed", { url: req.url, error: err.stack });
      if (res.headersSent) {
        res.destroy(); // too late for a status code: cut the connection so the client sees a failure
        return;
      }
      const headers = { ...(err.extra ?? {}) };
      if (status === 413) headers.Connection = "close"; // the unread body is not worth draining
      sendJson(res, status, { error: status === 500 ? "internal error" : err.message }, headers);
    }
  };
}
