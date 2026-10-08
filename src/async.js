// Small async building blocks shared by the asset pipeline and the lobby. Nothing here
// knows about the DOM, so all of it runs (and is tested) in Node too.

/** Rejects with an AbortError-like reason when `signal` aborts. Used to bail out of
 * `await`s that have no signal of their own (a backoff sleep, a decode). */
export function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** setTimeout as a Promise — the "callback → Promise" step in its smallest form —
 * that also clears its timer and rejects as soon as `signal` aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(id);
      reject(signal.reason);
    };
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Resolves with `event.detail` the first time `target` fires `type`. */
export function once(target, type, { signal } = {}) {
  return abortable(
    new Promise((resolve) => {
      target.addEventListener(type, (e) => resolve(e.detail), { once: true, signal });
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
export async function* ticks(intervalMs, signal) {
  for (let n = 0; !signal.aborted; n++) {
    yield n;
    await sleep(intervalMs, signal);
  }
}

export function isAbortError(err) {
  return err?.name === "AbortError";
}
