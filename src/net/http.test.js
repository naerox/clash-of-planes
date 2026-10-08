import test from "node:test";
import assert from "node:assert/strict";
import {
  HttpError,
  ParseError,
  backoffDelay,
  fetchBytes,
  fetchJson,
  isRetryable,
  withRetry,
} from "./http.js";

const noJitter = () => 0.999; // deterministic: the top of each backoff window
const fast = { baseMs: 1, capMs: 5, random: noJitter };

function respond(body, { status = 200 } = {}) {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

/** A fetch stand-in that plays back a script of responses/errors and counts calls. */
function scripted(...steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, signal: init.signal });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(init) : step;
  };
  return { fetchImpl, calls };
}

test("backoffDelay grows exponentially, is capped, and is jittered", () => {
  const top = (n) => backoffDelay(n, { baseMs: 100, capMs: 1000, random: () => 0.999 });
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(top), [99, 199, 399, 799, 999, 999]);
  assert.equal(backoffDelay(3, { baseMs: 100, random: () => 0 }), 0, "full jitter can be 0");
});

test("isRetryable: 5xx, timeouts and network errors yes; 4xx, aborts, parse errors no", () => {
  assert.equal(isRetryable(new HttpError("u", 503)), true);
  assert.equal(isRetryable(new HttpError("u", 404)), false);
  assert.equal(isRetryable(new HttpError("u", 429)), false);
  assert.equal(isRetryable(new DOMException("t", "TimeoutError")), true);
  assert.equal(isRetryable(new TypeError("Failed to fetch")), true);
  assert.equal(isRetryable(new DOMException("a", "AbortError")), false);
  assert.equal(isRetryable(new ParseError("u", new SyntaxError("x"))), false);
});

test("fetchJson checks res.ok: a 404 throws HttpError after exactly one attempt", async () => {
  const { fetchImpl, calls } = scripted(respond("nope", { status: 404 }));
  await assert.rejects(fetchJson("/missing.json", { fetchImpl, ...fast }), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 404);
    return true;
  });
  assert.equal(calls.length, 1, "4xx is never retried");
});

test("5xx is retried with backoff, then succeeds", async () => {
  const { fetchImpl, calls } = scripted(
    respond("", { status: 503 }),
    respond("", { status: 502 }),
    respond('{"ok":true}'),
  );
  const retries = [];
  const data = await fetchJson("/flaky.json", {
    fetchImpl,
    ...fast,
    onRetry: (r) => retries.push(r),
  });
  assert.deepEqual(data, { ok: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(
    retries.map((r) => r.attempt),
    [1, 2],
  );
});

test("gives up after `retries` extra attempts and rethrows the last error", async () => {
  const { fetchImpl, calls } = scripted(new TypeError("Failed to fetch"));
  await assert.rejects(fetchBytes("/x", { fetchImpl, retries: 2, ...fast }), TypeError);
  assert.equal(calls.length, 3);
});

test("broken JSON becomes a ParseError (not retried)", async () => {
  const { fetchImpl, calls } = scripted(respond('{"lobby": {'));
  await assert.rejects(fetchJson("/broken.json", { fetchImpl, ...fast }), ParseError);
  assert.equal(calls.length, 1);
});

test("each attempt has its own timeout; a timed-out attempt is retried", async () => {
  let n = 0;
  const hang = (init) =>
    new Promise((resolve, reject) => {
      if (++n === 1) init.signal.addEventListener("abort", () => reject(init.signal.reason));
      else resolve(respond("[]"));
    });
  const { fetchImpl, calls } = scripted(hang);
  // Node's AbortSignal.timeout timer is unref'd and won't keep the test process alive alone.
  const keepAlive = setTimeout(() => {}, 1000);
  const data = await fetchJson("/slow", { fetchImpl, timeoutMs: 30, ...fast });
  clearTimeout(keepAlive);
  assert.deepEqual(data, []);
  assert.equal(calls.length, 2);
});

test("a caller abort stops immediately — no retry, even mid-backoff", async () => {
  const ac = new AbortController();
  const { fetchImpl, calls } = scripted(respond("", { status: 500 }));
  const p = withRetry(
    async (signal) => {
      const res = await fetchImpl("/x", { signal });
      if (!res.ok) throw new HttpError("/x", res.status);
    },
    { signal: ac.signal, retries: 5, baseMs: 10_000, capMs: 10_000, random: noJitter },
  );
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, { name: "AbortError" });
  assert.equal(calls.length, 1, "the 10 s backoff sleep was cut short by the abort");
});

test("fetchBytes reports byte progress while streaming the body", async () => {
  const body = new Uint8Array(10_000).fill(7);
  const { fetchImpl } = scripted(
    () => new Response(body, { headers: { "content-length": String(body.length) } }),
  );
  const seen = [];
  const out = await fetchBytes("/blob", { fetchImpl, onBytes: (l, t) => seen.push([l, t]) });
  assert.equal(out.length, 10_000);
  assert.deepEqual(seen.at(-1), [10_000, 10_000]);
});
