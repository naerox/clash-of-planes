// Serving the built client (client/dist): MIME types, caching headers, and a guard that no
// request can ever name a file outside the dist directory.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

export const MIME = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ndjson": "application/x-ndjson; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
});

/**
 * Turns the *raw* request path into a safe relative path, or throws a PathError.
 *
 * It must look at the raw text. `new URL("/a/../b", base)` quietly normalises `..` away,
 * which would hide exactly the attempt we want to reject. So: percent-decode first (an
 * attacker sends `%2e%2e` and `..%2f`), then refuse any `..` segment, NUL byte or backslash.
 */
export class PathError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function safeRelativePath(rawTarget) {
  const rawPath = rawTarget.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new PathError(400, "malformed percent-encoding");
  }
  if (decoded.includes("\0")) throw new PathError(400, "NUL byte in path");
  if (decoded.includes("\\")) throw new PathError(403, "backslash in path");
  if (decoded.split("/").some((segment) => segment === "..")) {
    throw new PathError(403, "path traversal");
  }
  return decoded;
}

/** Second line of defence: whatever the path, the resolved file must lie inside `root`. */
export function resolveInside(root, relative) {
  const base = resolve(root);
  const file = resolve(join(base, relative));
  return file === base || file.startsWith(base + sep) ? file : null;
}

// Vite fingerprints its bundles (`index-BsnFg-_R.js`): safe to cache forever. Everything
// else — index.html, our unhashed sprites and sounds — must be revalidated.
const HASHED = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

export async function serveStatic(req, res, { root, relative }) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let file = resolveInside(root, relative === "/" ? "/index.html" : relative);
  if (!file) throw new PathError(403, "outside the client directory");

  let info = await stat(file).catch((err) => {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  });
  if (info?.isDirectory()) {
    file = join(file, "index.html");
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
    return;
  }

  const etag = `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
  const headers = {
    "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": info.size,
    ETag: etag,
    "Last-Modified": info.mtime.toUTCString(),
    "Cache-Control": HASHED.test(file) ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": headers["Cache-Control"] }).end();
    return;
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  // pipeline: backpressure from a slow client, and the file handle is closed if it hangs up
  await pipeline(createReadStream(file), res);
}
