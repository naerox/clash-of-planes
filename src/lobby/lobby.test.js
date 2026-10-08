import test from "node:test";
import assert from "node:assert/strict";
import { Lobby, parseRooms, validateName } from "./lobby.js";
import { once, sleep } from "../async.js";

const ROOMS = {
  rooms: [
    { id: "a", name: "Alpha", players: 1, maxPlayers: 4, arena: { asteroids: 3 } },
    { id: "full", name: "Full", players: 2, maxPlayers: 2, arena: {} },
  ],
};

function fakeFetch(handler = () => ROOMS) {
  const calls = [];
  const fetchJson = async (url, { signal }) => {
    calls.push({ url, signal });
    return handler(signal, calls.length);
  };
  return { fetchJson, calls };
}

const hangUntilAborted = (signal) =>
  new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));

test("validateName trims and bounds the name", () => {
  assert.deepEqual(validateName("  Ace "), { ok: true, name: "Ace" });
  assert.equal(validateName("   ").ok, false);
  assert.equal(validateName("x".repeat(17)).ok, false);
});

test("parseRooms rejects a payload without a rooms array", () => {
  assert.throws(() => parseRooms({ nope: 1 }), TypeError);
  assert.equal(parseRooms(ROOMS).length, 2);
});

test("start() fetches at once, then polls on the interval; stop() ends polling", async () => {
  const { fetchJson, calls } = fakeFetch();
  const lobby = new Lobby({ fetchJson, intervalMs: 30, isVisible: () => true });
  const first = once(lobby, "rooms");
  lobby.start();
  assert.equal((await first).rooms.length, 2);
  await sleep(100);
  lobby.stop();
  const n = calls.length;
  assert.ok(n >= 3, `polled ${n} times`);
  await sleep(80);
  assert.equal(calls.length, n, "no requests after stop()");
});

test("a hidden page skips polls after the first one", async () => {
  const { fetchJson, calls } = fakeFetch();
  const lobby = new Lobby({ fetchJson, intervalMs: 20, isVisible: () => false });
  lobby.start();
  await sleep(100);
  lobby.stop();
  assert.equal(calls.length, 1);
});

test("every request carries a timeout: a hanging server becomes an error status", async () => {
  const { fetchJson } = fakeFetch((signal) => hangUntilAborted(signal));
  const lobby = new Lobby({ fetchJson, intervalMs: 10_000, timeoutMs: 30 });
  const statuses = [];
  lobby.addEventListener("status", (e) => statuses.push(e.detail));
  lobby.start();
  await sleep(80);
  lobby.stop();
  const err = statuses.find((s) => s.state === "error");
  assert.ok(err, "an error status was emitted");
  assert.match(err.error, /не відповів/);
});

test("stop() aborts the request in flight, silently", async () => {
  const { fetchJson, calls } = fakeFetch((signal) => hangUntilAborted(signal));
  const lobby = new Lobby({ fetchJson, intervalMs: 10_000, timeoutMs: 10_000 });
  const statuses = [];
  lobby.addEventListener("status", (e) => statuses.push(e.detail.state));
  lobby.start();
  await sleep(10);
  lobby.stop();
  await sleep(10);
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(statuses, ["loading"], "leaving the lobby is not reported as an error");
});

test("join validates, stops polling and emits join with the room config", async () => {
  const { fetchJson } = fakeFetch();
  const lobby = new Lobby({ fetchJson, intervalMs: 10_000 });
  const loaded = once(lobby, "rooms");
  lobby.start();
  await loaded;
  assert.throws(() => lobby.join("a", ""), RangeError);
  assert.throws(() => lobby.join("full", "Ace"), /заповнена/);
  const joined = once(lobby, "join");
  lobby.join("a", " Ace ");
  const detail = await joined;
  assert.equal(detail.name, "Ace");
  assert.deepEqual(detail.room.arena, { asteroids: 3 });
  assert.equal(lobby.running, false);
});
