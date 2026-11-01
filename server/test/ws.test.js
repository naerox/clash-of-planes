import test from "node:test";
import assert from "node:assert/strict";
import { createRoom, connect, hello, joined, say, sleep, startApp } from "./helpers.js";
import { CLOSE } from "../src/protocol.js";
import { closeReason, createSender } from "../src/ws.js";
import { silentLogger } from "../src/logger.js";

async function withRoom(env, fn) {
  const s = await startApp(env);
  try {
    const { body: room } = await createRoom(s.base, { name: "Arena", maxPlayers: 3 });
    await fn(s, room);
  } finally {
    await s.close();
  }
}

test("two clients join one room and chat; each sees the other's name", async () => {
  await withRoom({}, async (s, room) => {
    const a = await joined(s.wsUrl, room.id, "Ace");
    assert.equal(a.first.room.id, room.id);
    assert.deepEqual(
      a.first.players.map((p) => p.name),
      ["Ace"],
    );

    const b = await joined(s.wsUrl, room.id, "Bob");
    assert.deepEqual(
      b.first.players.map((p) => p.name),
      ["Ace", "Bob"],
    );
    const rosterForA = await a.next();
    assert.equal(rosterForA.type, "roster");
    assert.deepEqual(
      rosterForA.players.map((p) => p.name),
      ["Ace", "Bob"],
    );

    a.send(say("привіт, Bob"));
    for (const c of [a, b]) {
      const msg = await c.next();
      assert.equal(msg.type, "chat");
      assert.equal(msg.from.name, "Ace");
      assert.equal(msg.text, "привіт, Bob");
    }

    b.socket.close();
    const left = await a.next();
    assert.equal(left.type, "roster");
    assert.deepEqual(
      left.players.map((p) => p.name),
      ["Ace"],
    );
    a.socket.close();
  });
});

test("the room list shows live player counts; an emptied room disappears", async () => {
  await withRoom({}, async (s, room) => {
    const a = await joined(s.wsUrl, room.id, "Ace");
    let list = await (await fetch(`${s.base}/api/rooms`)).json();
    assert.equal(list.rooms[0].players, 1);
    a.socket.close();
    await a.closed;
    await sleep(30);
    list = await (await fetch(`${s.base}/api/rooms`)).json();
    assert.deepEqual(list.rooms, []);
  });
});

test("no join within the timeout → close 4003", async () => {
  await withRoom({ JOIN_TIMEOUT_MS: "80" }, async (s) => {
    const c = connect(s.wsUrl);
    const t0 = Date.now();
    const { code } = await c.closed;
    assert.equal(code, CLOSE.JOIN_TIMEOUT);
    assert.ok(Date.now() - t0 >= 70);
  });
});

test("joining cancels the timeout", async () => {
  await withRoom({ JOIN_TIMEOUT_MS: "80" }, async (s, room) => {
    const a = await joined(s.wsUrl, room.id, "Ace");
    await sleep(150);
    assert.equal(a.socket.readyState, 1, "still open");
    a.socket.close();
  });
});

test("every kind of bad message closes the socket with its own code", async () => {
  await withRoom({}, async (s, room) => {
    const cases = [
      ["{not json", CLOSE.BAD_MESSAGE],
      [JSON.stringify({ v: 1, type: "teleport" }), CLOSE.UNKNOWN_TYPE],
      [JSON.stringify({ v: 1, type: "join", room: room.id }), CLOSE.BAD_MESSAGE],
      [JSON.stringify({ v: 1, type: "chat", text: "hi" }), CLOSE.NOT_JOINED],
      [JSON.stringify({ v: 9, type: "leave" }), CLOSE.BAD_MESSAGE],
    ];
    for (const [payload, expected] of cases) {
      const c = connect(s.wsUrl);
      await c.opened;
      c.send(payload);
      assert.equal((await c.closed).code, expected, payload);
    }
  });
});

test("an oversize message closes with 1009 (ws enforces maxPayload)", async () => {
  await withRoom({ MAX_MESSAGE_BYTES: "256" }, async (s, room) => {
    const a = await joined(s.wsUrl, room.id, "Ace");
    a.socket.send(JSON.stringify({ v: 1, type: "chat", text: "x".repeat(2000) }));
    assert.equal((await a.closed).code, CLOSE.TOO_BIG);
  });
});

test("a binary frame closes with 1003", async () => {
  await withRoom({}, async (s) => {
    const c = connect(s.wsUrl);
    await c.opened;
    c.socket.send(Buffer.from([1, 2, 3]));
    assert.equal((await c.closed).code, CLOSE.UNSUPPORTED);
  });
});

test("joining a missing or full room, or a taken name, is rejected with 4004 and an error message", async () => {
  await withRoom({}, async (s) => {
    const { body: tiny } = await createRoom(s.base, { name: "Tiny", maxPlayers: 1 });

    const ghost = connect(s.wsUrl);
    await ghost.opened;
    ghost.send(hello("nope-0000", "X"));
    assert.equal((await ghost.next()).code, "no_such_room");
    assert.equal((await ghost.closed).code, CLOSE.JOIN_REJECTED);

    const a = await joined(s.wsUrl, tiny.id, "Ace");
    const late = connect(s.wsUrl);
    await late.opened;
    late.send(hello(tiny.id, "Bob"));
    assert.equal((await late.next()).code, "room_full");
    assert.equal((await late.closed).code, CLOSE.JOIN_REJECTED);

    const { body: pair } = await createRoom(s.base, { name: "Pair", maxPlayers: 2 });
    await joined(s.wsUrl, pair.id, "Cy");
    const dupe = connect(s.wsUrl);
    await dupe.opened;
    dupe.send(hello(pair.id, "cy"));
    assert.equal((await dupe.next()).code, "name_taken");
    assert.equal((await dupe.closed).code, CLOSE.JOIN_REJECTED);
    a.socket.close();
  });
});

test("a hostile message type cannot crash the server through the close reason (123-byte limit)", async () => {
  await withRoom({}, async (s, room) => {
    for (const type of ["я".repeat(500), "x".repeat(900), "🚀".repeat(100)]) {
      const c = connect(s.wsUrl);
      await c.opened;
      c.send({ v: 1, type });
      const { code, reason } = await c.closed;
      assert.equal(code, CLOSE.UNKNOWN_TYPE);
      assert.ok(Buffer.byteLength(reason) <= 123, `reason is ${Buffer.byteLength(reason)} bytes`);
    }
    const ok = await joined(s.wsUrl, room.id, "Still");
    assert.equal(ok.first.type, "joined", "the server is still up and serving");
    ok.socket.close();
  });
});

test("closeReason cuts by bytes on a character boundary", () => {
  assert.equal(closeReason("short"), "short");
  const cut = closeReason("я".repeat(100)); // 2 bytes each
  assert.equal(Buffer.byteLength(cut), 120);
  assert.equal(cut, "я".repeat(60));
  assert.equal(closeReason("🚀".repeat(50)), "🚀".repeat(30)); // 4 bytes each, never half an emoji
});

test("a second join on a joined socket → 4005", async () => {
  await withRoom({}, async (s, room) => {
    const a = await joined(s.wsUrl, room.id, "Ace");
    a.send(hello(room.id, "Ace2"));
    assert.equal((await a.closed).code, CLOSE.ALREADY_JOINED);
  });
});

test("rate limit: a flood closes the socket with 1008; normal pace does not", async () => {
  await withRoom({ RATE_PER_SEC: "5", RATE_BURST: "5" }, async (s, room) => {
    const calm = await joined(s.wsUrl, room.id, "Calm");
    for (let i = 0; i < 4; i++) {
      calm.send(say(`m${i}`));
      await sleep(250);
    }
    assert.equal(calm.socket.readyState, 1);

    const flood = await joined(s.wsUrl, room.id, "Flood");
    for (let i = 0; i < 30; i++) flood.send(say(`spam ${i}`));
    assert.equal((await flood.closed).code, CLOSE.POLICY);
    calm.socket.close();
  });
});

test("'leave' closes politely with 1000 and the roster shrinks", async () => {
  await withRoom({}, async (s, room) => {
    const a = await joined(s.wsUrl, room.id, "Ace");
    const b = await joined(s.wsUrl, room.id, "Bob");
    await a.next(); // roster after Bob joined
    b.send({ v: 1, type: "leave" });
    assert.equal((await b.closed).code, CLOSE.NORMAL);
    assert.deepEqual(
      (await a.next()).players.map((p) => p.name),
      ["Ace"],
    );
    a.socket.close();
  });
});

test("heartbeat: a client that never answers pings is terminated after two misses", async () => {
  await withRoom({ HEARTBEAT_MS: "40", MAX_MISSED_PONGS: "2" }, async (s, room) => {
    const deaf = connect(s.wsUrl, { autoPong: false });
    await deaf.opened;
    deaf.send(hello(room.id, "Deaf"));
    await deaf.next();
    const t0 = Date.now();
    const { code } = await deaf.closed;
    assert.equal(code, 1006, "terminated, no close handshake");
    const dt = Date.now() - t0;
    assert.ok(dt >= 70 && dt < 400, `terminated after ${dt} ms (≈ 3 ticks of 40 ms)`);
    await sleep(30);
    assert.equal(
      (await (await fetch(`${s.base}/api/rooms`)).json()).rooms.length,
      0,
      "left the room",
    );
  });
});

test("heartbeat: a client that answers pongs stays connected", async () => {
  await withRoom({ HEARTBEAT_MS: "30" }, async (s, room) => {
    const a = await joined(s.wsUrl, room.id, "Ace"); // `ws` clients answer pings automatically
    await sleep(200);
    assert.equal(a.socket.readyState, 1);
    a.socket.close();
  });
});

test("a socket 'error' is handled, the server keeps serving", async () => {
  await withRoom({}, async (s, room) => {
    const keeper = await joined(s.wsUrl, room.id, "Keeper"); // keeps the room from emptying
    const a = await joined(s.wsUrl, room.id, "Ace");
    a.socket._socket.destroy(new Error("boom")); // abrupt transport failure
    await a.closed;
    const b = await joined(s.wsUrl, room.id, "Bob");
    assert.equal(b.first.type, "joined");
    b.socket.close();
    keeper.socket.close();
  });
});

test("only /ws upgrades; other paths are refused", async () => {
  await withRoom({}, async (s) => {
    const c = connect(`ws://127.0.0.1:${s.port}/elsewhere`);
    const res = await new Promise((resolve) =>
      c.socket.on("unexpected-response", (_, r) => resolve(r.statusCode)),
    );
    assert.equal(res, 400);
  });
});

test("slow-client policy: non-critical dropped past slowDropBytes, connection closed past slowCloseBytes", () => {
  const config = { slowDropBytes: 1000, slowCloseBytes: 5000 };
  const sent = [];
  let closed = null;
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (data, cb) => (sent.push(data), cb?.()),
    close: (code) => (closed = code),
  };
  const stats = { dropped: 0 };
  const send = createSender(socket, config, silentLogger, stats);

  assert.equal(send({ n: 1 }, { critical: false }), true);
  socket.bufferedAmount = 2000; // behind, but not hopeless
  assert.equal(send({ n: 2 }, { critical: false }), false, "chat is dropped");
  assert.equal(send({ n: 3 }), true, "a critical message still goes out");
  assert.equal(stats.dropped, 1);
  assert.equal(closed, null);
  socket.bufferedAmount = 9000; // hopeless
  assert.equal(send({ n: 4 }), false);
  assert.equal(closed, CLOSE.TRY_LATER);
  assert.equal(sent.length, 2);
  socket.readyState = 3;
  assert.equal(send({ n: 5 }), false, "nothing is written to a closed socket");
});
