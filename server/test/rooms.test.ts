import test from "node:test";
import assert from "node:assert/strict";
import { jsonCodec, toClient, type ArenaConfig } from "@dogfight/shared";
import {
  Room,
  RoomError,
  RoomManager,
  type ControlFrame,
  type Player,
  type RoomLogEntry,
  type RoomOptions,
  type SendOptions,
} from "../src/rooms.ts";
import { sleep } from "./helpers.ts";

/** A real `Player` (the interface the Room needs), remembering what it was sent. */
function player(id: string, name: string) {
  const sent: [ControlFrame, SendOptions | undefined][] = [];
  const p: Player & { sent: typeof sent } = {
    id,
    name,
    codec: jsonCodec,
    shipId: null,
    sent,
    send(message, options) {
      sent.push([message, options]);
      return true;
    },
    deliver: () => 0,
    deliverControl() {},
    kick() {},
  };
  return p;
}
const arena: ArenaConfig = { asteroids: 3, hunters: 0, asteroidSpeed: [10, 20] };
const room = (over: Partial<RoomOptions> = {}) =>
  new Room({ id: "r-1", name: "R", arena, maxPlayers: 2, ...over });

test("join/leave emit events, in order, synchronously", () => {
  const r = room();
  const seen: string[] = [];
  r.on("join", (p) => seen.push(`join ${p.name}`));
  r.on("leave", (p) => seen.push(`leave ${p.name}`));
  const a = player("a", "Ace");
  r.join(a);
  seen.push("after join");
  r.leave(a);
  assert.deepEqual(seen, ["join Ace", "after join", "leave Ace"]);
});

test("a full room and a taken name (any case) are refused with a RoomError code", () => {
  const r = room();
  r.join(player("a", "Ace"));
  assert.throws(() => r.join(player("b", "ACE")), { code: "name_taken" });
  r.join(player("b", "Bob"));
  assert.throws(
    () => r.join(player("c", "Cy")),
    (e: unknown) => e instanceof RoomError && e.code === "room_full",
  );
  assert.equal(r.size, 2);
});

test("leaving twice is harmless; the last leave emits 'empty' once", () => {
  const r = room();
  let empties = 0;
  r.on("empty", () => empties++);
  const a = player("a", "Ace");
  r.join(a);
  r.leave(a);
  r.leave(a);
  assert.equal(empties, 1);
});

test("chat emits 'chat' and an 'event' record for the match log", () => {
  const r = room({ now: () => 1234 });
  const events: RoomLogEntry[] = [];
  r.on("event", (e) => events.push(e));
  const a = player("a", "Ace");
  r.join(a);
  const msg = r.chat(a, "hello");
  assert.deepEqual(msg, { from: { id: "a", name: "Ace" }, text: "hello", t: 1234 });
  assert.deepEqual(
    events.map((e) => e.type),
    ["join", "chat"],
  );
  assert.deepEqual(events[1], {
    t: 1234,
    room: "r-1",
    type: "chat",
    player: "a",
    name: "Ace",
    text: "hello",
  });
});

test("broadcast reaches everyone except `except`, and carries the critical flag", () => {
  const r = room({ maxPlayers: 3 });
  const [a, b, c] = [player("a", "A"), player("b", "B"), player("c", "C")];
  [a, b, c].forEach((p) => r.join(p));
  const frame = toClient.error("x", "y");
  r.broadcast(frame, { critical: false, except: "b" });
  assert.deepEqual(a.sent, [[frame, { critical: false }]]);
  assert.equal(b.sent.length, 0);
  assert.equal(c.sent.length, 1);
});

test("an emptied room is deleted by the manager; 'removed' fires with a closing event", () => {
  const m = new RoomManager();
  const removed: string[] = [];
  m.on("removed", (r) => removed.push(r.id));
  const r = m.create({ name: "Belt", arena });
  const closing: string[] = [];
  r.on("event", (e) => closing.push(e.type));
  const a = player("a", "Ace");
  r.join(a);
  assert.equal(m.size, 1);
  r.leave(a);
  assert.equal(m.size, 0);
  assert.deepEqual(removed, [r.id]);
  assert.deepEqual(closing, ["join", "leave", "room_closed"]);
});

test("ids are url-safe slugs with a random suffix; non-latin names fall back to 'room'", () => {
  const m = new RoomManager();
  assert.match(m.create({ name: "Пояс астероїдів", arena }).id, /^room-[0-9a-f]{4}$/);
  assert.match(m.create({ name: "Big  Belt!", arena }).id, /^big-belt-[0-9a-f]{4}$/);
});

test("rooms-per-server and players-per-room caps", () => {
  const m = new RoomManager({ maxRooms: 2, maxPlayersPerRoom: 4 });
  const r = m.create({ name: "a", arena, maxPlayers: 99 });
  assert.equal(r.maxPlayers, 4, "a room cannot exceed the server-wide cap");
  m.create({ name: "b", arena });
  assert.throws(() => m.create({ name: "c", arena }), { code: "too_many_rooms" });
});

test("a room nobody joins expires after idleMs; one that was joined does not", async () => {
  const m = new RoomManager({ idleMs: 30 });
  const lonely = m.create({ name: "lonely", arena });
  const used = m.create({ name: "used", arena });
  used.join(player("a", "Ace"));
  await sleep(80);
  assert.equal(m.get(lonely.id), undefined);
  assert.equal(m.get(used.id), used);
});

test("closeAll removes every room", () => {
  const m = new RoomManager();
  m.create({ name: "a", arena });
  m.create({ name: "b", arena });
  m.closeAll();
  assert.equal(m.size, 0);
});

test("a Room's events are typed: a payload of the wrong type does not compile", () => {
  const r = room();
  // @ts-expect-error "chat" carries a ChatMessage, not a number
  r.emit("chat", 42);
  // @ts-expect-error there is no event called "explode"
  r.on("explode", () => {});
  assert.ok(r);
});
