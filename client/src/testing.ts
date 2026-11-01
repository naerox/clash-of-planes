// Typed builders for the tests: a snapshot, a ship, an input … with sensible defaults, so no
// test needs a fake object or an `as` cast to get the branded numbers right.

import {
  NO_SEQ,
  entityId,
  seq,
  shotSeq,
  tick,
  type AsteroidSnap,
  type BulletSnap,
  type InputMessage,
  type JoinedMessage,
  type PickupSnap,
  type ShipSnap,
  type ShipState,
  type SnapshotMessage,
} from "@dogfight/shared";

export function snap(tickNo: number, extra: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    type: "snapshot",
    tick: tick(tickNo),
    ack: NO_SEQ,
    you: null,
    ships: [],
    bullets: [],
    asteroids: [],
    pickups: [],
    events: [],
    ...extra,
  };
}

export function shipSnap(id: number, x: number, y: number, angle = 0): ShipSnap {
  return {
    kind: "ship",
    id: entityId(id),
    x,
    y,
    angle,
    hp: 100,
    thrusting: false,
    dead: false,
    rapid: false,
    score: 0,
  };
}

export function bulletSnap(id: number, owner: number, x: number, y: number, s = 0): BulletSnap {
  return { kind: "bullet", id: entityId(id), owner: entityId(owner), x, y, seq: shotSeq(s) };
}

export function asteroidSnap(id: number, x: number, y: number, radius = 30): AsteroidSnap {
  return { kind: "asteroid", id: entityId(id), x, y, angle: 0, radius, hunter: false };
}

export function pickupSnap(id: number, x: number, y: number): PickupSnap {
  return { kind: "pickup", id: entityId(id), x, y, variant: "shield" };
}

export function youState(over: Partial<ShipState> = {}): ShipState {
  return {
    id: entityId(1),
    x: 800,
    y: 450,
    vx: 0,
    vy: 0,
    angle: 0,
    hp: 100,
    cooldown: 0,
    rapid: 0,
    respawn: 0,
    score: 0,
    thrusting: false,
    ...over,
  };
}

export function input(over: Partial<Omit<InputMessage, "type">> = {}): InputMessage {
  return {
    type: "input",
    seq: seq(1),
    tick: tick(0),
    thrust: false,
    turn: 0,
    fire: false,
    ...over,
  };
}

export function joinedMsg(over: Partial<Omit<JoinedMessage, "type">> = {}): JoinedMessage {
  return {
    type: "joined",
    room: { id: "belt-ab12", name: "Belt", players: 1, maxPlayers: 8, arena: {} },
    you: "p1",
    shipId: entityId(1),
    players: [{ id: "p1", name: "Ace", shipId: entityId(1) }],
    seed: 42,
    tickRate: 30,
    tick: tick(0),
    codec: "binary",
    ...over,
  };
}
