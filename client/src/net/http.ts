// The one place that talks to `fetch`. Every asset loader and the lobby go through
// `fetchBytes`/`fetchJson`, so `ok`-checking, timeouts, retries and byte progress are
// implemented once.

import { sleep } from "../async.ts";

export class HttpError extends Error {
  readonly url: string;
  readonly status: number;

  constructor(url: string, status: number, statusText = "", detail = "") {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ""}${detail ? `: ${detail}` : ""}`);
    this.name = "HttpError";
    this.url = url;
    this.status = status;
  }
}

export class ParseError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`Битий JSON: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
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
export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 500;
  if (err instanceof Error && err.name === "TimeoutError") return true;
  return err instanceof TypeError;
}

/** Exponential backoff with "full jitter": a random delay in [0, min(cap, base·2^n)).
 * The randomness spreads clients out so they don't all retry in the same instant. */
export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  random?: () => number;
}

export function backoffDelay(
  attempt: number,
  { baseMs = 250, capMs = 4000, random = Math.random }: BackoffOptions = {},
): number {
  return Math.floor(random() * Math.min(capMs, baseMs * 2 ** attempt));
}

/**
 * Runs `task(signal, attempt)` until it succeeds, a non-retryable error happens, or
 * `attempts` tries in total are used up. Each attempt gets its own `AbortSignal.timeout`,
 * combined with the caller's signal: a timeout fails that one attempt (and may be
 * retried), while the caller's abort stops everything at once, including the backoff sleep.
 */
export interface RetryOptions extends BackoffOptions {
  signal?: AbortSignal;
  attempts?: number;
  timeoutMs?: number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export async function withRetry<T>(
  task: (signal: AbortSignal, attempt: number) => Promise<T>,
  { signal, attempts = 4, timeoutMs = 8000, onRetry, random, baseMs, capMs }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await task(attemptSignal, attempt);
    } catch (caught: unknown) {
      if (signal?.aborted) throw signal.reason;
      const err: unknown = timeout.aborted
        ? new DOMException(`Сервер не відповів за ${timeoutMs} мс`, "TimeoutError")
        : caught;
      if (attempt + 1 >= attempts || !isRetryable(err)) throw err;
      const delayMs = backoffDelay(attempt, { random, baseMs, capMs });
      onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      await sleep(delayMs, signal);
    }
  }
}

/** Async iteration over a fetch body: one Uint8Array chunk per network read. */
export async function* chunksOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
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

/** Bytes in a buffer of their own (not a view into a shared one): a valid `BlobPart`. */
export type Bytes = Uint8Array<ArrayBuffer>;

async function readBytes(
  res: Response,
  onBytes?: (loaded: number, total: number) => void,
): Promise<Bytes> {
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onBytes?.(buf.length, total || buf.length);
    return buf;
  }
  const parts: Uint8Array[] = [];
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
/** The slice of `fetch` we use; the real one satisfies it, and so does a test double. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchOptions extends RetryOptions {
  onBytes?: (loaded: number, total: number) => void;
  fetchImpl?: Fetcher;
  init?: RequestInit;
}

export function fetchBytes(
  url: string,
  { onBytes, fetchImpl = globalThis.fetch, init, ...retryOpts }: FetchOptions = {},
): Promise<Bytes> {
  return withRetry(async (signal) => {
    const res = await fetchImpl(url, { ...init, signal });
    if (!res.ok) {
      // our own server explains itself as { "error": "…" }; show that instead of a bare status
      const detail = await res.json().then(
        (body: unknown) => errorText(body),
        () => "",
      );
      throw new HttpError(url, res.status, res.statusText, detail);
    }
    return readBytes(res, onBytes);
  }, retryOpts);
}

/** Our server explains itself as `{ "error": "…" }`. */
function errorText(body: unknown): string {
  if (typeof body !== "object" || body === null || !("error" in body)) return "";
  return typeof body.error === "string" ? body.error.slice(0, 200) : "";
}

/**
 * The shared JSON fetcher: `ok` is checked in fetchBytes, a bad body becomes a ParseError. The
 * result is `unknown` on purpose — the caller owns the schema that says what it must look like.
 */
export type FetchJson = (url: string, opts?: FetchOptions) => Promise<unknown>;

export const fetchJson: FetchJson = async (url, opts) => {
  const bytes = await fetchBytes(url, opts);
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch (err: unknown) {
    throw new ParseError(url, err);
  }
};
