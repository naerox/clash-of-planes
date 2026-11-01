// The HTTP layer, on bare `node:http`: a router of about ten lines, a capped body reader and
// JSON helpers. (Fastify/Express would hide all of this — the Stretch asks what exactly.)

import { createReadStream } from "node:fs";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { MIME, PathError, safeRelativePath, serveStatic } from "./static.ts";
import { listReplays, replayPath } from "./log/replay.ts";
import { TICK_RATE, hasControl, type ArenaConfig } from "@dogfight/shared";
import { z } from "zod";
import type { ServerConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import { RoomError, type RoomManager } from "./rooms.ts";

export type Headers = Record<string, string>;

export class HttpError extends Error {
  readonly status: number;
  readonly extra: Headers | undefined;

  constructor(status: number, message: string, extra?: Headers) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Headers = {}): void {
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
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (declared > maxBytes) throw new HttpError(413, `body is limited to ${maxBytes} bytes`);

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) throw new HttpError(400, "unreadable body");
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

/** POST /api/rooms: unknown JSON in, a clean `{ name, arena, maxPlayers }` out (or a 400). */
function roomRequestSchema(maxPlayersPerRoom: number) {
  const speed = z.number().int().min(0).max(400);
  return z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .refine((s) => !hasControl(s), "must not contain control characters"),
    arena: z
      .object({
        asteroids: z.number().int().min(0).max(20).default(4),
        hunters: z.number().int().min(0).max(6).default(1),
        asteroidSpeed: z
          .tuple([speed, speed])
          .refine(([lo, hi]) => lo <= hi, "min must not exceed max")
          .default([40, 100]),
      })
      .prefault({}),
    maxPlayers: z.number().int().min(1).max(maxPlayersPerRoom).default(maxPlayersPerRoom),
  });
}

export interface RoomRequest {
  readonly name: string;
  readonly arena: ArenaConfig;
  readonly maxPlayers: number;
}

export function parseRoomRequest(
  body: unknown,
  { maxPlayersPerRoom }: { maxPlayersPerRoom: number },
): RoomRequest {
  const parsed = roomRequestSchema(maxPlayersPerRoom).safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.join(".");
  throw new HttpError(400, `${where || "body"}: ${issue?.message ?? "invalid"}`);
}

export interface HttpDeps {
  config: ServerConfig;
  rooms: RoomManager;
  log: Logger;
}

export function createRequestListener({ config, rooms, log }: HttpDeps): RequestListener {
  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { pathname } = url;
    const method = req.method;
    const target = req.url ?? "/";

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
        } catch (err: unknown) {
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
    const replayId = replay?.[1];
    if (replayId !== undefined && method === "GET") return streamReplay(res, replayId);

    if (config.debugRoutes) {
      // Lab 4, M4 demos — never enabled by default.
      if (pathname === "/api/slow") {
        const ms = Math.min(Number(url.searchParams.get("ms")) || 300, 5000);
        const end = performance.now() + ms;
        while (performance.now() < end); // blocks the event loop on purpose
        return sendJson(res, 200, { blockedMs: ms });
      }
      const naive = /^\/api\/replays-naive\/([^/]+)$/.exec(pathname);
      const naiveId = naive?.[1];
      if (naiveId !== undefined) return naiveReplay(res, naiveId);
    }

    if (pathname.startsWith("/api/")) throw new HttpError(404, "no such endpoint");
    const relative = safeRelativePath(target);
    return serveStatic(req, res, { root: config.clientDist, relative });
  }

  async function streamReplay(res: ServerResponse, id: string): Promise<void> {
    const file = replayPath(config.logDir, id);
    const info = file ? await stat(file).catch(() => null) : null;
    if (!file || !info?.isFile()) throw new HttpError(404, "no such replay");
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
  async function naiveReplay(res: ServerResponse, id: string): Promise<void> {
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
      const target = req.url ?? "/";
      let url: URL;
      try {
        url = new URL(target, "http://localhost");
      } catch {
        throw new HttpError(400, "malformed request target");
      }
      safeRelativePath(target); // `..` anywhere — API or static — is refused up front
      await route(req, res, url);
    } catch (err: unknown) {
      // the client hung up mid-download (a slow reader giving up): nothing to answer, not an error
      const code = err instanceof Error && "code" in err ? err.code : undefined;
      if (code === "ERR_STREAM_PREMATURE_CLOSE" || res.destroyed) return;
      const status = err instanceof HttpError || err instanceof PathError ? err.status : 500;
      if (status === 500) {
        log.error("request failed", {
          url: req.url,
          error: err instanceof Error ? err.stack : String(err),
        });
      }
      if (res.headersSent) {
        res.destroy(); // too late for a status code: cut the connection so the client sees a failure
        return;
      }
      const headers: Headers = { ...(err instanceof HttpError ? err.extra : undefined) };
      if (status === 413) headers.Connection = "close"; // the unread body is not worth draining
      const message = err instanceof Error ? err.message : "error";
      sendJson(res, status, { error: status === 500 ? "internal error" : message }, headers);
    }
  };
}
