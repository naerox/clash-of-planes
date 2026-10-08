// Minimal stand-in for the Lab 4 server, mounted into Vite (dev and preview) as middleware.
//
//   GET /api/rooms            static rooms from rooms.json, player counts jittered per request
//   GET /assets/<missing>     a real 404 (instead of Vite's index.html fallback)
//   any path ?delay=ms        answer after `ms` (to make loading measurable, or to time out)
//   any path ?status=503      answer with that HTTP status instead
//   …&times=N&key=K           apply delay/status only to the first N requests with key K

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOMS_FILE = new URL("./rooms.json", import.meta.url);
const PUBLIC_DIR = new URL("../public/", import.meta.url);
const hits = new Map();

export function devApi() {
  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    const q = url.searchParams;

    const times = q.has("times") ? Number(q.get("times")) : Infinity;
    const key = `${q.get("key") ?? ""}|${url.pathname}`;
    const n = hits.get(key) ?? 0;
    hits.set(key, n + 1);
    const faulty = n < times;

    const delay = Math.min(Number(q.get("delay")) || 0, 30_000);
    if (faulty && delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (faulty && q.has("status")) {
      res.statusCode = Number(q.get("status"));
      res.end(`injected ${res.statusCode}`);
      return;
    }

    if (url.pathname === "/api/rooms") {
      const { rooms } = JSON.parse(await readFile(ROOMS_FILE, "utf8"));
      for (const r of rooms) {
        if (r.players < r.maxPlayers) {
          const d = Math.round(Math.random() * 2 - 1);
          r.players = Math.max(0, Math.min(r.maxPlayers - 1, r.players + d));
        }
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify({ rooms, serverTime: Date.now() }));
      return;
    }
    // Vite's SPA fallback would answer a missing /assets/… file with index.html and 200;
    // a real static server says 404, and the failure gallery needs that honest answer.
    if (url.pathname.startsWith("/assets/")) {
      const file = fileURLToPath(new URL(`.${url.pathname}`, PUBLIC_DIR));
      if (!file.startsWith(fileURLToPath(PUBLIC_DIR)) || !existsSync(file)) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }
    }
    next();
  }

  return {
    name: "dev-api",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
