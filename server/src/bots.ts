// Server-side AI players. A bot is a `Player` like any other: it sits in the room, has a ship in
// the match, shows up in the roster — and its ONLY way to act is `match.receiveInput(...)` with
// an `InputMessage`, the very message a browser sends over the socket. Everything between that
// call and the world (the per-player rate limit, the queue, the jitter reserve) is shared with
// humans, so the server cannot tell the difference, and a bot cannot cheat.

import {
  ARENA,
  Rng,
  angleDelta,
  jsonCodec,
  seq as toSeq,
  tick,
  wrappedDelta,
  type InputMessage,
  type Turn,
  type World,
  type Ship,
} from "@dogfight/shared";
import type { Match } from "./match.ts";
import type { Player, Room } from "./rooms.ts";

/** What produces a stream of inputs: a human's socket handler, or `ChaserAi` below. */
export interface PlayerInput {
  /** The input for this step, or `null` to stay quiet. `n` counts from 1. */
  next(n: number, world: World, ship: Ship): InputMessage | null;
}

/** Chases the nearest other ship, shoots when roughly aimed, and sheers off rocks. */
export class ChaserAi implements PlayerInput {
  readonly #rng: Rng;

  constructor(seed: number) {
    this.#rng = new Rng(seed);
  }

  next(n: number, world: World, ship: Ship): InputMessage | null {
    if (ship.isDead) return null;
    let target: { dx: number; dy: number; d: number } | null = null;
    for (const other of world.ofKind("ship")) {
      if (other === ship || other.isDead) continue;
      const dx = wrappedDelta(ship.pos.x, other.pos.x, ARENA.width);
      const dy = wrappedDelta(ship.pos.y, other.pos.y, ARENA.height);
      const d = Math.hypot(dx, dy);
      if (!target || d < target.d) target = { dx, dy, d };
    }
    // a rock close ahead matters more than a target far away
    for (const rock of world.ofKind("asteroid")) {
      const dx = wrappedDelta(ship.pos.x, rock.pos.x, ARENA.width);
      const dy = wrappedDelta(ship.pos.y, rock.pos.y, ARENA.height);
      const d = Math.hypot(dx, dy);
      if (d < rock.radius + 110) {
        const away = Math.atan2(-dy, -dx);
        return this.#input(n, angleDelta(ship.angle, away), true, false);
      }
    }
    if (!target) return this.#input(n, 0.4, true, false);
    const diff = angleDelta(ship.angle, Math.atan2(target.dy, target.dx));
    const wobble = (this.#rng.next() - 0.5) * 0.1; // a human is never perfectly steady
    const fire = Math.abs(diff) < 0.15 && target.d < 900;
    return this.#input(n, diff + wobble, target.d > 320, fire);
  }

  #input(n: number, steer: number, thrust: boolean, fire: boolean): InputMessage {
    const turn: Turn = steer > 0.08 ? 1 : steer < -0.08 ? -1 : 0;
    return { type: "input", seq: toSeq(n), tick: tick(0), thrust, turn, fire };
  }
}

/** A room member with no socket. */
export interface BotPlayer extends Player {
  readonly isBot: true;
}

/** Adds and removes bots; each bot gets one input per match tick, sent through `receiveInput`. */
export class BotManager {
  readonly #bots = new Map<string, { player: BotPlayer; ai: PlayerInput; n: number }>();
  #counter = 0;
  readonly #hooked = new WeakSet<Match>();

  /** Adds up to `count` bots to `room`; returns how many fitted. */
  add(room: Room, count: number): number {
    const match = room.match;
    if (!match) return 0;
    let added = 0;
    for (; added < count && room.size < room.maxPlayers; added++) {
      const id = `bot-${++this.#counter}`;
      const player: BotPlayer = {
        id,
        name: `Bot ${this.#counter}`,
        isBot: true,
        codec: jsonCodec,
        shipId: null,
        send: () => true,
        deliver: () => 0, // a bot reads the world itself; nobody encodes a snapshot for it
        deliverControl() {},
        kick: () => this.remove(room, id),
      };
      room.join(player);
      this.#bots.set(id, { player, ai: new ChaserAi(0xb07 + this.#counter), n: 0 });
    }
    this.#hook(room, match);
    return added;
  }

  /** Removes every bot from `room` (or just one). */
  remove(room: Room, id?: string): number {
    let removed = 0;
    for (const [botId, bot] of this.#bots) {
      if ((id !== undefined && botId !== id) || !room.players.has(botId)) continue;
      room.leave(bot.player);
      this.#bots.delete(botId);
      removed++;
    }
    return removed;
  }

  botsIn(room: Room): number {
    let n = 0;
    for (const id of this.#bots.keys()) if (room.players.has(id)) n++;
    return n;
  }

  /** Feeds the bots once per tick, before the match applies inputs. */
  #hook(room: Room, match: Match): void {
    if (this.#hooked.has(match)) return;
    this.#hooked.add(match);
    match.beforeStep.add(() => {
      for (const [id, bot] of this.#bots) {
        if (!room.players.has(id)) continue;
        const ship = bot.player.shipId === null ? undefined : match.world.get(bot.player.shipId);
        if (!ship || ship.kind !== "ship") continue;
        const input = bot.ai.next(++bot.n, match.world, ship);
        if (input) match.receiveInput(bot.player, input);
      }
    });
    // when the last human leaves, the bots go too: a room of bots alone would run forever
    room.on("leave", () => {
      const humans = [...room.players.values()].filter((p) => !("isBot" in p));
      if (humans.length === 0) this.remove(room);
    });
  }
}
