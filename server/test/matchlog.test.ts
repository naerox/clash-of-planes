import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MatchLogs, NdjsonEncoder, createMatchLog } from "../src/log/matchlog.ts";
import { replayEvents, replayPath } from "../src/log/replay.ts";
import { asObject, jsonBody, joined, openRoom, say, sleep, startApp } from "./helpers.ts";

const tmp = () => mkdtemp(join(tmpdir(), "dogfight-log-"));
const parseLines = (text: string): Record<string, unknown>[] =>
  text
    .split("\n")
    .filter(Boolean)
    .map((l): unknown => JSON.parse(l))
    .map(asObject);
const lines = async (file: string) => parseLines(await readFile(file, "utf8"));
const fakeRoom = (id = "r-1") => Object.assign(new EventEmitter(), { id });

test("NdjsonEncoder: one object in → one JSON line out (object mode on the write side)", async () => {
  const chunks: string[] = [];
  await pipeline(
    Readable.from([{ a: 1 }, { b: "ї" }], { objectMode: true }),
    new NdjsonEncoder(),
    new Writable({
      write(c, _e, cb) {
        chunks.push(c.toString());
        cb();
      },
    }),
  );
  assert.equal(chunks.join(""), '{"a":1}\n{"b":"ї"}\n');
});

test("NdjsonEncoder fails the stream on something JSON cannot hold", async () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  await assert.rejects(
    pipeline(
      Readable.from([circular], { objectMode: true }),
      new NdjsonEncoder(),
      new Writable({ write: (_c, _e, cb) => cb() }),
    ),
    TypeError,
  );
});

test("createMatchLog writes every event, in order, including those emitted just before stop()", async () => {
  const dir = await tmp();
  try {
    const room = fakeRoom();
    const log = createMatchLog(room, { dir, now: () => 1700000000000 });
    assert.match(log.file, /r-1-1700000000000\.ndjson$/);
    room.emit("event", { t: 1, type: "join" });
    room.emit("event", { t: 2, type: "chat", text: "hi" });
    for (let i = 0; i < 5000; i++) room.emit("event", { t: 3, type: "tick", i }); // a burst with no await between
    room.emit("event", { t: 4, type: "room_closed" });
    await log.stop();
    const got = await lines(log.file);
    assert.equal(got.length, 5003);
    assert.deepEqual(got[0], { t: 1, type: "join" });
    assert.deepEqual(got[1], { t: 2, type: "chat", text: "hi" });
    assert.equal(got[5001]?.i, 4999);
    assert.deepEqual(got.at(-1), { t: 4, type: "room_closed" });
    assert.equal(room.listenerCount("event"), 0, "no listener leaks after stop");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stop() on a log with no events leaves an empty, closed file", async () => {
  const dir = await tmp();
  try {
    const log = createMatchLog(fakeRoom(), { dir });
    await log.stop();
    assert.equal(await readFile(log.file, "utf8"), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a write failure is reported through onError and does not throw out of stop()", async () => {
  const errors: (string | undefined)[] = [];
  const room = fakeRoom();
  const log = createMatchLog(room, {
    dir: "/definitely/not/a/dir",
    onError: (e) => errors.push("code" in e && typeof e.code === "string" ? e.code : undefined),
  });
  room.emit("event", { t: 1 });
  await log.stop();
  assert.deepEqual(errors, ["ENOENT"]);
  assert.equal(room.listenerCount("event"), 0, "a failed log unsubscribes: no unbounded queue");
});

test("MatchLogs.closeAll flushes every active log", async () => {
  const dir = await tmp();
  try {
    const logs = new MatchLogs({ dir });
    const [a, b] = [fakeRoom("a-1"), fakeRoom("b-2")];
    const fa = logs.attach(a).file;
    const fb = logs.attach(b).file;
    a.emit("event", { n: 1 });
    b.emit("event", { n: 2 });
    await logs.closeAll();
    assert.deepEqual(await lines(fa), [{ n: 1 }]);
    assert.deepEqual(await lines(fb), [{ n: 2 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("replayEvents yields parsed events; a last line without a newline still counts", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "x.ndjson");
    await writeFile(file, '{"a":1}\n\n{"a":2}\n{"a":3}');
    const got: unknown[] = [];
    for await (const e of replayEvents(file)) got.push(asObject(e).a);
    assert.deepEqual(got, [1, 2, 3]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("replayEvents: a corrupt line throws with its line number, or is skipped via onBadLine", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "x.ndjson");
    await writeFile(file, '{"a":1}\n{"a":2\n{"a":3}\n');
    await assert.rejects(async () => {
      for await (const e of replayEvents(file)) void e;
    }, /x\.ndjson:2:/);
    const bad: number[] = [];
    const got: unknown[] = [];
    for await (const e of replayEvents(file, { onBadLine: (b) => bad.push(b.line) }))
      got.push(asObject(e).a);
    assert.deepEqual(got, [1, 3]);
    assert.deepEqual(bad, [2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("replayEvents: breaking out early closes the file (no leaked descriptor)", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "x.ndjson");
    await writeFile(file, Array.from({ length: 50_000 }, (_, i) => `{"i":${i}}`).join("\n"));
    for await (const e of replayEvents(file)) if (asObject(e).i === 3) break;
    await rm(file); // would fail on Windows if the handle leaked; on Linux this just must not hang
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("replay ids: only <slug>-<timestamp>, never a path", () => {
  assert.equal(
    replayPath("/logs", "belt-ab12-1700000000000"),
    "/logs/belt-ab12-1700000000000.ndjson",
  );
  for (const id of [
    "../x",
    "a/b",
    "x.ndjson",
    "x",
    "a-b-1",
    "belt-ab12-1700000000000/../../etc",
    "",
  ]) {
    assert.equal(replayPath("/logs", id), null, id);
  }
});

test("end to end: a room's whole life lands in its NDJSON log, and /api/replays streams it back", async () => {
  const s = await startApp();
  try {
    const room = await openRoom(s.base, { name: "Belt" });
    const a = await joined(s.wsUrl, room.id, "Ace");
    const b = await joined(s.wsUrl, room.id, "Bob");
    await a.next();
    a.send(say("перший"));
    await b.next(); // roster? no — chat
    a.socket.close();
    b.socket.close();
    await b.closed;
    await sleep(80); // room empties → removed → log stopped and flushed

    const { replays } = await jsonBody(await fetch(`${s.base}/api/replays`));
    assert.ok(Array.isArray(replays));
    assert.equal(replays.length, 1);
    const { id, size } = asObject(replays[0]);
    assert.equal(typeof id, "string");
    assert.match(String(id), /^belt-[0-9a-f]{4}-\d{13}$/);

    const res = await fetch(`${s.base}/api/replays/${id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /x-ndjson/);
    assert.equal(Number(res.headers.get("content-length")), size);
    const body = await res.text();
    const events = parseLines(body);
    assert.deepEqual(
      events.map((e) => e.type),
      ["room_opened", "join", "join", "chat", "leave", "leave", "room_closed"],
    );
    assert.deepEqual(
      events.filter((e) => e.type === "join").map((e) => e.name),
      ["Ace", "Bob"],
    );
    assert.equal(events.find((e) => e.type === "chat")?.text, "перший");
    assert.equal(events.at(-1)?.reason, "empty");
    assert.ok(events.every((e) => e.room === room.id && typeof e.t === "number"));

    // the same file through the async generator
    const viaGenerator: unknown[] = [];
    for await (const e of replayEvents(join(s.dir, `${String(id)}.ndjson`))) viaGenerator.push(e);
    assert.deepEqual(viaGenerator, events);
  } finally {
    await s.close();
  }
});

test("/api/replays/:id refuses anything that is not a known replay id", async () => {
  const s = await startApp();
  try {
    await writeFile(join(s.dir, "secret.txt"), "nope");
    for (const id of ["nope-1700000000000", "secret.txt", "x"]) {
      const res = await fetch(`${s.base}/api/replays/${id}`);
      assert.equal(res.status, 404, id);
    }
    // `..` in any spelling never even reaches the router (403, same guard as static files)
    assert.equal((await fetch(`${s.base}/api/replays/..%2fsecret`)).status, 403);
  } finally {
    await s.close();
  }
});
