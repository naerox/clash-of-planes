import { test, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { Bus } from "../events.ts";
import { saveNotice, takeNotice } from "../ui/notice.ts";
import { watchForLoss, type WatchedEvents } from "./lobbyReturn.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(giveUpAfterMs = 10_000) {
  const bus = new Bus<WatchedEvents>();
  const lost: string[] = [];
  watchForLoss(bus, { giveUpAfterMs, onLost: (r) => lost.push(r) });
  const status = (state: "open" | "reconnecting" | "connecting"): void =>
    bus.emit("status", { state, attempt: 0 });
  return { bus, lost, status };
}

test("a short outage is survived: the countdown stops when the socket opens again", () => {
  const { lost, status } = setup();
  status("reconnecting");
  vi.advanceTimersByTime(6000);
  status("open");
  vi.advanceTimersByTime(60_000);
  assert.deepEqual(lost, []);
});

test("a server that stays away: back to the lobby after the grace period, with a reason", () => {
  const { lost, status } = setup(10_000);
  status("reconnecting");
  vi.advanceTimersByTime(9999);
  assert.equal(lost.length, 0);
  vi.advanceTimersByTime(2);
  assert.deepEqual(lost, ["Сервер недоступний — ви повернулися в лобі."]);
});

test("after the server's own `shutdown` message the reason says it is restarting", () => {
  const { bus, lost, status } = setup(5000);
  bus.emit("shutdown", {
    type: "shutdown",
    reason: "server shutting down",
    reconnectAfterMs: 3000,
  });
  status("reconnecting");
  vi.advanceTimersByTime(5001);
  assert.match(lost[0] ?? "", /перезапускається/);
});

test("the server came back as a fresh process: `no_such_room`, then a fatal close — the room is gone", () => {
  const { bus, lost } = setup();
  bus.emit("error", { type: "error", code: "no_such_room", message: "no such room" });
  bus.emit("closed", { code: 4004, reason: "no such room", fatal: true });
  assert.match(lost[0] ?? "", /кімнати вже немає/);
});

test("any other final close is reported with its meaning, and only once", () => {
  const { bus, lost, status } = setup(1000);
  status("reconnecting");
  bus.emit("closed", { code: 1008, reason: "rate limit", fatal: true });
  vi.advanceTimersByTime(5000); // the countdown must not fire a second report
  assert.equal(lost.length, 1);
  assert.match(lost[0] ?? "", /ліміт повідомлень/);
});

test("the notice survives a reload exactly once, and a broken storage never throws", () => {
  const data = new Map<string, string>();
  const storage = {
    setItem: (k: string, v: string) => void data.set(k, v),
    getItem: (k: string) => data.get(k) ?? null,
    removeItem: (k: string) => void data.delete(k),
  };
  saveNotice("Сервер перезапустився", storage);
  assert.equal(takeNotice(storage), "Сервер перезапустився");
  assert.equal(takeNotice(storage), null, "shown once");
  const broken = {
    setItem: () => {
      throw new Error("blocked");
    },
    getItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {},
  };
  assert.doesNotThrow(() => saveNotice("x", broken));
  assert.equal(takeNotice(broken), null);
});
