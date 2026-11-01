// Small async building blocks shared by the asset pipeline and the lobby. Nothing here
// knows about the DOM, so all of it runs (and is tested) in Node too.

import type { Bus } from "./events.ts";

/** `AbortSignal.reason` can be anything; a rejection should be an Error (DOMException is one). */
const asError = (reason: unknown): Error =>
  reason instanceof Error ? reason : new Error(String(reason));

/** Rejects with an AbortError-like reason when `signal` aborts. Used to bail out of
 * `await`s that have no signal of their own (a backoff sleep, a decode). */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(asError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(asError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** setTimeout as a Promise — the "callback → Promise" step in its smallest form —
 * that also clears its timer and rejects as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(asError(signal.reason));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(id);
      reject(asError(signal?.reason));
    };
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Resolves with the payload the first time `target` emits `type`; its type follows `type`. */
export function once<E, K extends keyof E>(
  target: Bus<E>,
  type: K,
  { signal }: { signal?: AbortSignal } = {},
): Promise<E[K]> {
  return abortable(
    new Promise<E[K]>((resolve) => {
      target.on(type, resolve, { once: true, signal });
    }),
    signal,
  );
}

/**
 * Async generator of polling ticks: yields immediately, then once every `intervalMs`,
 * until `signal` aborts. The consumer writes a plain `for await` loop, and the wait
 * between ticks starts only after the consumer's own `await` (the request) has finished,
 * so a slow server can never pile up overlapping requests the way `setInterval` would.
 */
export async function* ticks(intervalMs: number, signal: AbortSignal): AsyncGenerator<number> {
  for (let n = 0; !signal.aborted; n++) {
    yield n;
    await sleep(intervalMs, signal);
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
