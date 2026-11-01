import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { Connection, reconnectDelay } from "./connection.js";
import { describeClose, isFatalClose, msg } from "./protocol.js";

/** A WebSocket stand-in the test drives by hand. */
class FakeWebSocket extends EventTarget {
  static all = [];
  readyState = 0;
  sent = [];
  constructor(url) {
    super();
    this.url = url;
    FakeWebSocket.all.push(this);
  }
  send(data) {
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
  }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
  // test controls
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(message) {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(message) }));
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" }));
  }
}

function setup(options = {}) {
  FakeWebSocket.all = [];
  mock.timers.enable({ apis: ["setTimeout"] });
  const conn = new Connection({
    url: "ws://x/ws",
    WebSocketImpl: FakeWebSocket,
    handshake: () => msg.join("belt-0001", "Ace"),
    backoff: { baseMs: 100, capMs: 800, random: () => 1 }, // random()=1 → the top of each window
    ...options,
  });
  const states = [];
  conn.addEventListener("status", (e) => states.push(e.detail));
  const closed = [];
  conn.addEventListener("closed", (e) => closed.push(e.detail));
  return { conn, states, closed, sockets: FakeWebSocket.all };
}
const teardown = () => mock.timers.reset();

test("reconnectDelay doubles per attempt, is capped, and is jittered within [step/2, step]", () => {
  const top = (n) => reconnectDelay(n, { baseMs: 100, capMs: 800, random: () => 1 });
  const bottom = (n) => reconnectDelay(n, { baseMs: 100, capMs: 800, random: () => 0 });
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(top), [100, 200, 400, 800, 800, 800]);
  assert.deepEqual([0, 1, 2, 3, 4].map(bottom), [50, 100, 200, 400, 400]);
});

test("the handshake goes first, then the queue — in order", () => {
  const { conn, sockets } = setup();
  try {
    conn.connect();
    assert.equal(conn.state, "connecting");
    conn.send(msg.chat("one"));
    conn.send(msg.chat("two"));
    assert.equal(conn.queued, 2);
    sockets[0].open();
    assert.equal(conn.state, "open");
    assert.deepEqual(
      sockets[0].sent.map((m) => m.type),
      ["join", "chat", "chat"],
    );
    assert.deepEqual(
      sockets[0].sent.slice(1).map((m) => m.text),
      ["one", "two"],
    );
    assert.equal(conn.queued, 0);
    conn.send(msg.chat("three")); // open now: straight through
    assert.equal(sockets[0].sent.at(-1).text, "three");
  } finally {
    teardown();
  }
});

test("works without a handshake too", () => {
  const { conn, sockets } = setup({ handshake: null });
  try {
    conn.connect();
    conn.send({ hello: 1 });
    sockets[0].open();
    assert.deepEqual(sockets[0].sent, [{ hello: 1 }]);
  } finally {
    teardown();
  }
});

test("a dropped connection reconnects with growing pauses, re-sends the join, flushes what was queued meanwhile", () => {
  const { conn, states, sockets } = setup();
  try {
    conn.connect();
    sockets[0].open();
    sockets[0].drop(1006);
    assert.equal(conn.state, "reconnecting");
    assert.equal(states.at(-1).delayMs, 100);

    conn.send(msg.chat("while offline"));
    mock.timers.tick(99);
    assert.equal(sockets.length, 1, "not yet");
    mock.timers.tick(1);
    assert.equal(sockets.length, 2);

    sockets[1].drop(1006); // never opened: the next pause is longer
    assert.equal(states.at(-1).delayMs, 200);
    mock.timers.tick(200);
    assert.equal(sockets.length, 3);
    sockets[2].open();
    assert.deepEqual(
      sockets[2].sent.map((m) => m.type),
      ["join", "chat"],
    );
    assert.equal(sockets[2].sent[1].text, "while offline");
  } finally {
    teardown();
  }
});

test("the pause is capped, and a message from the server resets the attempt counter", () => {
  const { conn, states, sockets } = setup();
  try {
    conn.connect();
    for (let i = 0; i < 6; i++) {
      sockets.at(-1).drop(1006);
      mock.timers.tick(10_000);
    }
    const delays = states.filter((s) => s.delayMs).map((s) => s.delayMs);
    assert.deepEqual(delays, [100, 200, 400, 800, 800, 800]);

    sockets.at(-1).open();
    sockets.at(-1).receive({ type: "joined" }); // healthy again
    sockets.at(-1).drop(1006);
    assert.equal(states.at(-1).delayMs, 100, "back to the first step");
  } finally {
    teardown();
  }
});

test("fatal close codes end the connection: no reconnect", () => {
  for (const code of [1008, 1009, 4004, 4000]) {
    const { conn, closed, sockets } = setup();
    try {
      conn.connect();
      sockets[0].open();
      sockets[0].drop(code);
      assert.equal(conn.state, "closed");
      assert.deepEqual(closed, [{ code, reason: "", fatal: true }]);
      mock.timers.tick(60_000);
      assert.equal(sockets.length, 1, `no new socket after ${code}`);
      assert.equal(conn.send(msg.chat("x")), false, "sending on a closed connection is refused");
    } finally {
      teardown();
    }
  }
});

test("server going away (1001) and 'try later' (1013) are retried", () => {
  for (const code of [1001, 1013]) {
    const { conn, sockets } = setup();
    try {
      conn.connect();
      sockets[0].open();
      sockets[0].drop(code);
      assert.equal(conn.state, "reconnecting");
      mock.timers.tick(1000);
      assert.equal(sockets.length, 2);
    } finally {
      teardown();
    }
  }
});

test("close() is final: cancels a pending reconnect and discards the queue", () => {
  const { conn, closed, sockets } = setup();
  try {
    conn.connect();
    sockets[0].open();
    sockets[0].drop(1006);
    conn.send(msg.chat("never sent"));
    conn.close();
    mock.timers.tick(60_000);
    assert.equal(sockets.length, 1);
    assert.equal(conn.state, "closed");
    assert.equal(conn.queued, 0);
    assert.equal(closed.length, 1);
  } finally {
    teardown();
  }
});

test("close() on an open socket closes it and does not reconnect", () => {
  const { conn, closed, sockets } = setup();
  try {
    conn.connect();
    sockets[0].open();
    conn.close(1000, "bye");
    assert.equal(conn.state, "closed");
    assert.equal(closed[0].code, 1000);
    mock.timers.tick(60_000);
    assert.equal(sockets.length, 1);
  } finally {
    teardown();
  }
});

test("messages are dispatched under 'message' and under their own type; garbage is ignored", () => {
  const { conn, sockets } = setup();
  try {
    conn.connect();
    sockets[0].open();
    const seen = [];
    conn.addEventListener("message", (e) => seen.push(["message", e.detail.type]));
    conn.addEventListener("roster", (e) => seen.push(["roster", e.detail.players.length]));
    sockets[0].receive({ type: "roster", players: [1, 2] });
    sockets[0].dispatchEvent(Object.assign(new Event("message"), { data: "{not json" }));
    sockets[0].dispatchEvent(Object.assign(new Event("message"), { data: "42" }));
    sockets[0].receive({ nope: true });
    assert.deepEqual(seen, [
      ["message", "roster"],
      ["roster", 2],
    ]);
  } finally {
    teardown();
  }
});

test("the queue is bounded: send() reports false instead of growing without limit", () => {
  const { conn } = setup({ maxQueue: 3 });
  try {
    conn.connect();
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((n) => conn.send(msg.chat(`m${n}`))),
      [true, true, true, false, false],
    );
    assert.equal(conn.queued, 3);
  } finally {
    teardown();
  }
});

test("events of a superseded socket are ignored", () => {
  const { conn, sockets } = setup();
  try {
    conn.connect();
    sockets[0].open();
    sockets[0].drop(1006);
    mock.timers.tick(1000);
    const states = [];
    conn.addEventListener("status", (e) => states.push(e.detail.state));
    sockets[0].drop(1006); // a late duplicate from the dead socket
    assert.deepEqual(states, []);
  } finally {
    teardown();
  }
});

test("a connection attempt that never opens is abandoned after connectTimeoutMs, then retried", () => {
  const { conn, sockets, states } = setup({ connectTimeoutMs: 1000 });
  try {
    conn.connect();
    mock.timers.tick(999);
    assert.equal(conn.state, "connecting");
    mock.timers.tick(1);
    assert.equal(conn.state, "reconnecting");
    assert.equal(states.at(-1).delayMs, 100);
    mock.timers.tick(100);
    assert.equal(sockets.length, 2, "a fresh socket after the pause");
    sockets[0].open(); // the abandoned one waking up late must change nothing
    assert.equal(conn.state, "connecting");
    sockets[1].open();
    assert.equal(conn.state, "open");
    mock.timers.tick(60_000); // and an open socket is not timed out
    assert.equal(conn.state, "open");
  } finally {
    teardown();
  }
});

test("protocol helpers", () => {
  assert.deepEqual(msg.join("r-1", "Ace"), {
    v: 1,
    type: "join",
    room: "r-1",
    name: "Ace",
    codec: "binary",
  });
  assert.equal(msg.join("r-1", "Ace", "json").codec, "json");
  assert.deepEqual(msg.netsim({ latency: 100, jitter: 20, drop: 0.02 }), {
    v: 1,
    type: "netsim",
    latency: 100,
    jitter: 20,
    drop: 0.02,
  });
  assert.equal(isFatalClose(4004), true);
  assert.equal(isFatalClose(1006), false);
  assert.match(describeClose(4004), /кімнат/);
  assert.equal(describeClose(4999), "код 4999");
});

test("binary frames: the Connection reports their size and hands the ArrayBuffer on untouched", () => {
  const { conn, sockets } = setup();
  try {
    conn.connect();
    sockets[0].open();
    assert.equal(
      sockets[0].binaryType,
      "arraybuffer",
      "so the browser gives us ArrayBuffer, not Blob",
    );
    const frames = [];
    const binaries = [];
    conn.addEventListener("frame", (e) => frames.push(e.detail));
    conn.addEventListener("binary", (e) => binaries.push(e.detail));
    const buffer = new Uint8Array([2, 1, 0, 0]).buffer;
    sockets[0].dispatchEvent(Object.assign(new Event("message"), { data: buffer }));
    assert.deepEqual(frames, [{ size: 4, binary: true }]);
    assert.equal(binaries[0], buffer);
    sockets[0].receive({ type: "roster", players: [] });
    assert.equal(frames.at(-1).binary, false);
    assert.ok(frames.at(-1).size > 10, "text frames report their length");
  } finally {
    teardown();
  }
});

test("a binary frame counts as the server answering: it resets the reconnect backoff", () => {
  const { conn, states, sockets } = setup();
  try {
    conn.connect();
    sockets[0].drop(1006);
    mock.timers.tick(1000);
    sockets[1].drop(1006);
    mock.timers.tick(1000);
    sockets[2].open();
    sockets[2].dispatchEvent(Object.assign(new Event("message"), { data: new ArrayBuffer(4) }));
    sockets[2].drop(1006);
    assert.equal(states.at(-1).delayMs, 100, "back to the first step");
  } finally {
    teardown();
  }
});

test("sendNow transmits only on an open socket, and never queues", () => {
  const { conn, sockets } = setup();
  try {
    conn.connect();
    assert.equal(conn.sendNow("ping"), false, "still connecting");
    sockets[0].open();
    assert.equal(conn.sendNow(new Uint8Array([1, 2, 3])), true);
    assert.equal(conn.queued, 0);
    sockets[0].drop(1006);
    assert.equal(conn.sendNow("x"), false, "reconnecting: gone, not queued");
    assert.equal(conn.queued, 0);
  } finally {
    teardown();
  }
});
