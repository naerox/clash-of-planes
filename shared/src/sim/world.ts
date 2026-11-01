import { entityId, tick, TICK_ZERO, type EntityId, type Seq, type Tick } from "../brand.ts";
import type { Controls } from "../input.ts";
import { Vector2 } from "./vector.ts";
import { ARENA } from "./arena.ts";
import { TAU } from "./math.ts";
import { findCollisions } from "./collision.ts";
import { applyHoming, attachHoming } from "./homing.ts";
import type { EntityKind } from "./entity.ts";
import type { SimEvent } from "./events.ts";
import { isKind, type AnyEntity, type EntityOfKind } from "./kinds.ts";
import { Pickup, PICKUP_KINDS, PICKUP_PARAMS, type PickupType } from "./pickup.ts";
import { Asteroid, ASTEROID_CONTACT_DAMAGE, ASTEROID_PARAMS } from "./asteroid.ts";
import { Rng } from "./rng.ts";
import { Ship } from "./ship.ts";

export interface ArenaConfig {
  readonly asteroids: number;
  readonly hunters: number;
  readonly asteroidSpeed: readonly [min: number, max: number];
}

export const DEFAULT_ARENA: ArenaConfig = Object.freeze<ArenaConfig>({
  asteroids: 4,
  hunters: 1,
  asteroidSpeed: [40, 100],
});

export interface WorldOptions {
  seed?: number;
  arena?: Partial<ArenaConfig>;
}

/** One step of one ship: what the server applies per received input (see `applyInput`). */
export interface ShipInput extends Controls {
  readonly seq: Seq;
  readonly fire: boolean;
}

/**
 * The entity store and the step function. Lab 5 makes it the ONE simulation that the server
 * runs for real and (parts of it) the client re-runs for prediction, so it obeys the rules
 * that make that safe:
 *
 *  - no DOM, no Node built-ins, no clocks: it only does arithmetic on what it is given;
 *  - no `Math.random()`: every random choice comes from `this.rng`, seeded by the server;
 *  - ids are assigned here, in `spawn()`, in a fixed order;
 *  - iteration order is the Map's insertion order — deterministic;
 *  - what happened is reported through `events` (plain objects), not through callbacks.
 *
 * Ships are NOT moved by `step()`: a ship advances one step per input (`applyInput`), so a
 * client replaying its unacknowledged inputs reproduces the server's ship exactly.
 */
export class World {
  #entities = new Map<EntityId, AnyEntity>();
  #toDespawn = new Set<EntityId>();
  #pickupTimer = PICKUP_PARAMS.respawnDelay;

  tick: Tick = TICK_ZERO;
  nextId = 1;
  events: SimEvent[] = [];
  readonly seed: number;
  readonly rng: Rng;
  readonly arena: ArenaConfig;

  constructor({ seed = 1, arena = DEFAULT_ARENA }: WorldOptions = {}) {
    this.seed = seed >>> 0;
    this.rng = new Rng(seed);
    this.arena = { ...DEFAULT_ARENA, ...arena };
  }

  /**
   * Gives the entity the next free id and stores it. Ids are 1..65535 (they travel as a u16 in
   * the binary snapshot) and wrap around, skipping any id still in use — deterministically.
   */
  spawn<E extends AnyEntity>(entity: E): E {
    let id: EntityId;
    do {
      const n = this.nextId;
      id = entityId(n);
      this.nextId = n >= 65535 ? 1 : n + 1;
    } while (this.#entities.has(id));
    entity.id = id;
    this.#entities.set(id, entity);
    return entity;
  }

  /** Deferred removal: step() marks ids here and sweeps them at the end. */
  despawn(id: EntityId): void {
    this.#toDespawn.add(id);
  }

  get(id: EntityId): AnyEntity | undefined {
    return this.#entities.get(id);
  }

  get size(): number {
    return this.#entities.size;
  }

  [Symbol.iterator](): IterableIterator<AnyEntity> {
    return this.#entities.values();
  }

  *ofKind<K extends EntityKind>(kind: K): Generator<EntityOfKind<K>> {
    for (const e of this) if (isKind(e, kind)) yield e;
  }

  /** Records something that happened this tick (shot, hit, explosion) for the snapshot. */
  emit(event: SimEvent): void {
    this.events.push(event);
  }

  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ---- building the world -------------------------------------------------------------

  spawnAsteroid(pos: Vector2, vel: Vector2, radius = ASTEROID_PARAMS.maxRadius): Asteroid {
    const spin = (this.rng.next() - 0.5) * ASTEROID_PARAMS.spin;
    return this.spawn(new Asteroid(pos, vel, radius, ASTEROID_PARAMS, spin));
  }

  spawnPickupAt(
    pos: Vector2,
    type: PickupType = this.rng.chance(0.5) ? PICKUP_KINDS.SHIELD : PICKUP_KINDS.RAPID,
  ): Pickup {
    return this.spawn(new Pickup(pos, type));
  }

  #randomAsteroidVelocity(): Vector2 {
    const [lo, hi] = this.arena.asteroidSpeed;
    return Vector2.fromAngle(this.rng.next() * TAU, this.rng.range(lo, hi));
  }

  /** The arena's opening state: some asteroids, some homing "hunters", one pickup. */
  populate(): this {
    for (let i = 0; i < this.arena.asteroids; i++) {
      this.spawnAsteroid(this.randomSafeSpot(120), this.#randomAsteroidVelocity());
    }
    for (let i = 0; i < this.arena.hunters; i++) {
      const hunter = this.spawnAsteroid(
        this.randomSafeSpot(120),
        Vector2.zero,
        ASTEROID_PARAMS.minRadius,
      );
      attachHoming(hunter, null); // each tick it hunts the nearest living ship
    }
    this.spawnPickupAt(this.randomSafeSpot(260));
    return this;
  }

  /** A spot at least `avoidRadius` from every asteroid (and `awayFromShips` from every ship). */
  randomSafeSpot(avoidRadius = 160, awayFromShips = 0): Vector2 {
    for (let attempt = 0; attempt < 20; attempt++) {
      const pos = new Vector2(this.rng.next() * ARENA.width, this.rng.next() * ARENA.height);
      let safe = true;
      for (const a of this.ofKind("asteroid")) {
        if (pos.sub(a.pos).length() < avoidRadius + a.radius) {
          safe = false;
          break;
        }
      }
      if (safe && awayFromShips > 0) {
        for (const s of this.ofKind("ship")) {
          if (!s.isDead && pos.sub(s.pos).length() < awayFromShips) {
            safe = false;
            break;
          }
        }
      }
      if (safe) return pos;
    }
    return new Vector2(ARENA.width / 2, ARENA.height / 2);
  }

  addShip(playerId: string | null = null): Ship {
    const ship = new Ship(this.randomSafeSpot(200, 300));
    ship.playerId = playerId;
    ship.prevPos = ship.pos;
    ship.prevAngle = ship.angle;
    return this.spawn(ship);
  }

  // ---- running it ---------------------------------------------------------------------

  /**
   * One input for one ship = one step of that ship. `input` is { seq, thrust, turn, fire }.
   * Used by the server for every input it receives, and by tests; the client runs the same
   * two calls (`integrate`, `tryFire`) on its own copy of the ship.
   */
  applyInput(ship: Ship, input: ShipInput, dt: number): void {
    ship.integrate(input, dt);
    if (input.fire) ship.fire(this, input.seq);
  }

  /** One fixed tick of everything that is not a ship's own motion. */
  step(dt: number): void {
    for (const e of this) {
      if (!e.alive || e.kind === "ship") continue;
      // Captured BEFORE update(): Vector2 never mutates, so this stays the previous value.
      e.prevPos = e.pos;
      e.prevAngle = e.angle;
      if (e.homing) applyHoming(e, dt, this);
      e.update(dt);
    }

    for (const ship of this.ofKind("ship")) ship.tickRespawn(dt, this);

    for (const [a, b] of findCollisions(this)) resolvePair(a, b, this);

    for (const e of this) if (!e.alive) this.#toDespawn.add(e.id);
    for (const id of this.#toDespawn) this.#entities.delete(id);
    this.#toDespawn.clear();

    this.#pickupTimer -= dt;
    if (this.#pickupTimer <= 0) {
      this.spawnPickupAt(this.randomSafeSpot());
      this.#pickupTimer = PICKUP_PARAMS.respawnDelay;
    }

    // keep the field populated: a destroyed asteroid is eventually replaced
    const minField = Math.min(3, this.arena.asteroids);
    let rocks = 0;
    for (const a of this.ofKind("asteroid")) if (!a.homing) rocks++;
    if (rocks < minField && this.rng.chance(0.03)) {
      this.spawnAsteroid(this.randomSafeSpot(220, 300), this.#randomAsteroidVelocity());
    }

    this.tick = tick(this.tick + 1);
  }
}

function byKind<K extends EntityKind>(a: AnyEntity, b: AnyEntity, kind: K): EntityOfKind<K> | null {
  if (isKind(a, kind)) return a;
  if (isKind(b, kind)) return b;
  return null;
}

/** Collision *resolution*: what happens when two circles overlap. */
function resolvePair(a: AnyEntity, b: AnyEntity, world: World): void {
  const bullet = byKind(a, b, "bullet");
  const ship = byKind(a, b, "ship");
  const asteroid = byKind(a, b, "asteroid");
  const pickup = byKind(a, b, "pickup");

  if (bullet && ship && bullet.owner !== ship && !ship.isDead) {
    const wasAlive = ship.hp > 0;
    ship.takeDamage(bullet.damage, world);
    bullet.alive = false;
    world.emit({
      type: "hit",
      target: "ship",
      targetId: ship.id,
      x: bullet.pos.x,
      y: bullet.pos.y,
      damage: bullet.damage,
    });
    if (wasAlive && ship.hp === 0) bullet.owner.score++;
    return;
  }
  if (bullet && asteroid) {
    asteroid.hp -= bullet.damage;
    bullet.alive = false;
    world.emit({
      type: "hit",
      target: "asteroid",
      targetId: asteroid.id,
      x: bullet.pos.x,
      y: bullet.pos.y,
      damage: bullet.damage,
    });
    if (asteroid.hp <= 0) {
      asteroid.alive = false;
      world.emit({
        type: "exploded",
        kind: "asteroid",
        id: asteroid.id,
        x: asteroid.pos.x,
        y: asteroid.pos.y,
        radius: asteroid.radius,
      });
      bullet.owner.score++;
    }
    return;
  }
  if (ship && asteroid && !ship.isDead) {
    ship.takeDamage(ASTEROID_CONTACT_DAMAGE, world);
    return;
  }
  if (ship && pickup && !ship.isDead) {
    ship.applyPickup(pickup.type);
    pickup.alive = false;
  }
}
