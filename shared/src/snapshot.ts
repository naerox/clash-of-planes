// World → the logical snapshot message (codec-agnostic: plain numbers, strings and arrays).
// Both codecs turn this same object into bytes; the client's interpolation reads it back.
// The type (`SnapshotMessage`) is inferred from the Zod schema in protocol.ts.

import { NO_SEQ, shotSeq, type EntityId, type Seq } from "./brand.ts";
import type { SnapshotMessage } from "./protocol.ts";
import type { SimEvent } from "./sim/events.ts";
import type { World } from "./sim/world.ts";

export interface SnapshotOptions {
  /** The ship of the client this snapshot is for (its full state goes in `you`). */
  shipId?: EntityId | null;
  /** Last input seq the server applied for that client. */
  ack?: Seq;
  /** What happened during this tick (shared by all clients). */
  events?: SimEvent[];
}

export function buildSnapshot(
  world: World,
  { shipId = null, ack = NO_SEQ, events = [] }: SnapshotOptions = {},
): SnapshotMessage {
  const snap: SnapshotMessage = {
    type: "snapshot",
    tick: world.tick,
    ack,
    you: null,
    ships: [],
    bullets: [],
    asteroids: [],
    pickups: [],
    events,
  };
  for (const e of world) {
    switch (e.kind) {
      case "ship":
        if (e.id === shipId) snap.you = e.toState();
        else {
          snap.ships.push({
            kind: "ship",
            id: e.id,
            x: e.pos.x,
            y: e.pos.y,
            angle: e.angle,
            hp: e.hp,
            thrusting: e.thrusting,
            dead: e.isDead,
            rapid: e.rapidTimer > 0,
            score: e.score,
          });
        }
        break;
      case "bullet":
        snap.bullets.push({
          kind: "bullet",
          id: e.id,
          owner: e.owner.id,
          x: e.pos.x,
          y: e.pos.y,
          seq: shotSeq(e.seq),
        });
        break;
      case "asteroid":
        snap.asteroids.push({
          kind: "asteroid",
          id: e.id,
          x: e.pos.x,
          y: e.pos.y,
          angle: e.angle,
          radius: Math.round(e.radius),
          hunter: Boolean(e.homing),
        });
        break;
      case "pickup":
        snap.pickups.push({ kind: "pickup", id: e.id, x: e.pos.x, y: e.pos.y, variant: e.type });
        break;
      default: {
        const unreachable: never = e;
        return unreachable;
      }
    }
  }
  return snap;
}
