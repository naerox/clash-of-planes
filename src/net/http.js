// The one place that talks to `fetch`. Every asset loader and the lobby go through
// `fetchBytes`/`fetchJson`, so `ok`-checking, timeouts, retries and byte progress are
// implemented once.

import { sleep } from "../async.js";

export class HttpError extends Error {
  constructor(url, status, statusText = "") {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
    this.name = "HttpError";
    this.url = url;
    this.status = status;
  }
}

export class ParseError extends Error {
  constructor(url, cause) {
    super(`Битий JSON: ${cause.message}`, { cause });
    this.name = "ParseError";
    this.url = url;
  }
}

/**
 * Which failures are worth another attempt. 4xx means the request itself is wrong (no
 * such sprite, bad path) — asking again gives the same answer, so we never retry those.
 * 5xx, timeouts and network drops (`fetch` rejects with a TypeError) can be transient.
 * A user abort and a parse error are final.
 */
export function isRetryable(err) {
  if (err instanceof HttpError) return err.status >= 500;
  if (err?.name === "TimeoutError") return true;
  return err instanceof TypeError;
}

/** Exponential backoff with "full jitter": a random delay in [0, min(cap, base·2^n)).
 * The randomness spreads clients out so they don't all retry in the same instant. */
export function backoffDelay(attempt, { baseMs = 250, capMs = 4000, random = Math.random } = {}) {
  return Math.floor(random() * Math.min(capMs, baseMs * 2 ** attempt));
}

/**
 * Runs `task(signal, attempt)` until it succeeds, a non-retryable error happens, or
 * `retries` extra attempts are spent. Each attempt gets its own `AbortSignal.timeout`,
 * combined with the caller's signal: a timeout fails that one attempt (and may be
 * retried), while the caller's abort stops everything at once, including the backoff sleep.
 */
export async function withRetry(
  task,
  { signal, retries = 3, timeoutMs = 8000, onRetry, random, baseMs, capMs } = {},
) {
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await task(attemptSignal, attempt);
    } catch (caught) {
      if (signal?.aborted) throw signal.reason;
      const err = timeout.aborted
        ? new DOMException(`Сервер не відповів за ${timeoutMs} мс`, "TimeoutError")
        : caught;
      if (attempt >= retries || !isRetryable(err)) throw err;
      const delayMs = backoffDelay(attempt, { random, baseMs, capMs });
      onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      await sleep(delayMs, signal);
    }
  }
}

/** Async iteration over a fetch body: one Uint8Array chunk per network read. */
export async function* chunksOf(body) {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function readBytes(res, onBytes) {
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onBytes?.(buf.length, total || buf.length);
    return buf;
  }
  const parts = [];
  let loaded = 0;
  for await (const chunk of chunksOf(res.body)) {
    parts.push(chunk);
    loaded += chunk.length;
    onBytes?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** GET → checks `res.ok` → reads the body chunk by chunk, reporting bytes. Retries per `withRetry`. */
export function fetchBytes(
  url,
  { onBytes, fetchImpl = globalThis.fetch, init, ...retryOpts } = {},
) {
  return withRetry(async (signal) => {
    const res = await fetchImpl(url, { ...init, signal });
    if (!res.ok) throw new HttpError(url, res.status, res.statusText);
    return readBytes(res, onBytes);
  }, retryOpts);
}

/** The shared JSON fetcher: `ok` is checked in fetchBytes, a bad body becomes a ParseError. */
export async function fetchJson(url, opts) {
  const bytes = await fetchBytes(url, opts);
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ParseError(url, err);
  }
}
