// Dev-only fault injection for the Lab 3 failure gallery, mounted into Vite's dev server.
// It runs BEFORE Vite's own proxy, so the same switches also work on `/api/*` requests
// that are then forwarded to the real Node server (Lab 4).
//
//   any path ?delay=ms        answer after `ms` (to make loading measurable, or to time out)
//   any path ?status=503      answer with that HTTP status instead
//   …&times=N&key=K           apply delay/status only to the first N requests with key K
//   GET /assets/<missing>     a real 404 (Vite's SPA fallback would answer 200 + index.html)

import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";

const PUBLIC_DIR = new URL("../public/", import.meta.url);
const hits = new Map<string, number>();

export function devFaults(): Plugin {
  async function handler(
    req: Connect.IncomingMessage,
    res: ServerResponse,
    next: Connect.NextFunction,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = url.searchParams;

    if (q.has("delay") || q.has("status")) {
      const times = q.has("times") ? Number(q.get("times")) : Infinity;
      const key = `${q.get("key") ?? ""}|${url.pathname}`;
      const n = hits.get(key) ?? 0;
      hits.set(key, n + 1);
      if (n < times) {
        const delay = Math.min(Number(q.get("delay")) || 0, 30_000);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        if (q.has("status")) {
          res.statusCode = Number(q.get("status"));
          res.end(`injected ${res.statusCode}`);
          return;
        }
      }
    }

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
    name: "dev-faults",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
