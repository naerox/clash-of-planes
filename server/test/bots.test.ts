import { expect, test } from "vitest";
import { openRoom, joined, jsonBody, sleep, startApp, type TestServer } from "./helpers.ts";

async function addBots(s: TestServer, roomId: string, count: number) {
  const res = await fetch(`${s.base}/api/rooms/${roomId}/bots`, {
    method: "POST",
    body: JSON.stringify({ count }),
  });
  return { status: res.status, body: await jsonBody(res) };
}

test("bots join the room like players, fly, and go through the same input path as humans", async () => {
  const s = await startApp();
  try {
    const room = await openRoom(s.base, { name: "Bots", maxPlayers: 8 });
    const human = await joined(s.wsUrl, room.id, "Human");
    const r = await addBots(s, room.id, 3);
    expect(r).toEqual({ status: 200, body: { added: 3, bots: 3, players: 4 } });

    // the human is told about them in the roster, as about anyone else
    const roster = await human.nextOf("roster");
    expect(roster.players.map((p) => p.name)).toContain("Bot 1");

    const match = s.app.rooms.get(room.id)?.match;
    expect(match).toBeTruthy();
    /** Every bot's position, in a fixed order. */
    const botPositions = (): { x: number; y: number }[] =>
      [...(match?.world.ofKind("ship") ?? [])]
        .filter((ship) => ship.playerId?.startsWith("bot-"))
        .map((ship) => ({ x: ship.pos.x, y: ship.pos.y }));
    const before = botPositions();
    await sleep(600);
    const after = botPositions();
    expect(after).toHaveLength(3);
    const travelled = after.reduce(
      (sum, p, i) => sum + Math.hypot(p.x - (before[i]?.x ?? 0), p.y - (before[i]?.y ?? 0)),
      0,
    );
    expect(travelled).toBeGreaterThan(20);

    // their inputs are counted by the SAME counter as the human's (one input per bot per tick)
    const applied = match?.stats.inputsApplied ?? 0;
    expect(applied).toBeGreaterThan(30);

    // bots appear in snapshots as ordinary ships
    const snap = await human.untilSnapshot((x) => x.ships.length >= 3);
    expect(snap.ships.every((ship) => ship.kind === "ship")).toBe(true);
    human.socket.close();
  } finally {
    await s.close();
  }
});

test("a room never holds more than maxPlayers; extra bots are simply not added", async () => {
  const s = await startApp();
  try {
    const room = await openRoom(s.base, { name: "Small", maxPlayers: 4 });
    const human = await joined(s.wsUrl, room.id, "Human");
    expect((await addBots(s, room.id, 10)).body).toMatchObject({ added: 3, players: 4 });
    expect((await addBots(s, room.id, 1)).body).toMatchObject({ added: 0 });
    human.socket.close();
  } finally {
    await s.close();
  }
});

test("when the last human leaves the bots leave too, and the room is deleted", async () => {
  const s = await startApp();
  try {
    const room = await openRoom(s.base, { name: "Gone", maxPlayers: 8 });
    const human = await joined(s.wsUrl, room.id, "Human");
    await addBots(s, room.id, 4);
    human.socket.close();
    await human.closed;
    await sleep(100);
    expect(s.app.rooms.get(room.id)).toBeUndefined();
    expect(s.app.rooms.size).toBe(0);
  } finally {
    await s.close();
  }
});

test("DELETE removes the bots; bad requests are 400/404; ENABLE_BOTS=0 switches the endpoint off", async () => {
  const s = await startApp();
  const off = await startApp({ ENABLE_BOTS: "0" });
  try {
    const room = await openRoom(s.base, { name: "Del", maxPlayers: 8 });
    const human = await joined(s.wsUrl, room.id, "Human");
    await addBots(s, room.id, 2);
    const del = await fetch(`${s.base}/api/rooms/${room.id}/bots`, { method: "DELETE" });
    expect(await jsonBody(del)).toEqual({ removed: 2, players: 1 });
    expect((await addBots(s, room.id, 0)).status).toBe(400);
    expect((await addBots(s, "nope-0000", 1)).status).toBe(404);
    const other = await openRoom(off.base, { name: "Off" });
    expect((await addBots(off, other.id, 1)).status).toBe(404);
    human.socket.close();
  } finally {
    await s.close();
    await off.close();
  }
});
