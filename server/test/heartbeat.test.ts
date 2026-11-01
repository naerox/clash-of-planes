import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startHeartbeat, type Pingable } from "../src/heartbeat.ts";
import type { Logger } from "../src/logger.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

class FakeSocket implements Pingable {
  pings = 0;
  terminated = false;
  ping(): void {
    this.pings++;
  }
  terminate(): void {
    this.terminated = true;
  }
}

function setup(maxMissedPongs = 2) {
  const warnings: string[] = [];
  const log: Logger = { info() {}, error() {}, warn: (m) => void warnings.push(m) };
  const sockets = new Map<FakeSocket, { missed: number }>();
  const add = (): FakeSocket => {
    const s = new FakeSocket();
    sockets.set(s, { missed: 0 });
    return s;
  };
  const stop = startHeartbeat({
    clients: () => sockets.keys(),
    stateOf: (s) => sockets.get(s),
    intervalMs: 1000,
    maxMissedPongs,
    log,
  });
  return { sockets, add, stop, warnings };
}

test("every tick pings every socket and counts it as unanswered", () => {
  const { add, sockets } = setup();
  const a = add();
  vi.advanceTimersByTime(1000);
  expect(a.pings).toBe(1);
  expect(sockets.get(a)?.missed).toBe(1);
});

test("a pong (missed reset to 0) keeps the socket alive indefinitely", () => {
  const { add, sockets } = setup();
  const a = add();
  for (let i = 0; i < 20; i++) {
    vi.advanceTimersByTime(1000);
    const state = sockets.get(a);
    if (state) state.missed = 0; // what `socket.on("pong")` does
  }
  expect(a.terminated).toBe(false);
  expect(a.pings).toBe(20);
});

test("a socket that never answers is terminated on the tick after `maxMissedPongs` unanswered pings", () => {
  const { add, warnings } = setup(2);
  const deaf = add();
  vi.advanceTimersByTime(2000); // two pings, no pong
  expect(deaf.pings).toBe(2);
  expect(deaf.terminated).toBe(false);
  vi.advanceTimersByTime(1000);
  expect(deaf.terminated).toBe(true);
  expect(deaf.pings).toBe(2); // no third ping to a dead socket
  expect(warnings).toEqual(["heartbeat lost"]);
});

test("only the deaf one is cut off", () => {
  const { add, sockets } = setup(1);
  const live = add();
  const deaf = add();
  for (let i = 0; i < 3; i++) {
    vi.advanceTimersByTime(1000);
    const s = sockets.get(live);
    if (s) s.missed = 0;
  }
  expect(live.terminated).toBe(false);
  expect(deaf.terminated).toBe(true);
});

test("a socket we have no state for (not joined through our handler) is left alone", () => {
  const { sockets, add } = setup();
  const a = add();
  sockets.set(a, { missed: 0 });
  const stray = new FakeSocket();
  const stop = startHeartbeat({
    clients: () => [stray],
    stateOf: () => undefined,
    intervalMs: 1000,
    maxMissedPongs: 1,
    log: { info() {}, warn() {}, error() {} },
  });
  vi.advanceTimersByTime(5000);
  expect(stray.pings + Number(stray.terminated)).toBe(0);
  stop();
});

test("stop() ends the timer", () => {
  const { add, stop } = setup();
  const a = add();
  stop();
  vi.advanceTimersByTime(10_000);
  expect(a.pings).toBe(0);
});
