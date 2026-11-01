import { Vector2 } from "./vector.js";
import { ARENA } from "./arena.js";
import { TAU } from "./math.js";
import { findCollisions } from "./collision.js";
import { applyHoming, attachHoming } from "./homing.js";
import { Pickup, PICKUP_KINDS, PICKUP_PARAMS } from "./pickup.js";
import { Asteroid, ASTEROID_CONTACT_DAMAGE, ASTEROID_PARAMS } from "./asteroid.js";
import { Rng } from "./rng.js";
import { Ship } from "./ship.js";

export const DEFAULT_ARENA = Object.freeze({ asteroids: 4, hunters: 1, asteroidSpeed: [40, 100] });

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
  #entities = new Map();
  #toDespawn = new Set();
  #pickupTimer = PICKUP_PARAMS.respawnDelay;

  tick = 0;
  nextId = 1;
  events = [];

  constructor({ seed = 1, arena = DEFAULT_ARENA } = {}) {
    this.seed = seed >>> 0;
    this.rng = new Rng(seed);
    this.arena = { ...DEFAULT_ARENA, ...arena };
  }

  /**
   * Gives the entity the next free id and stores it. Ids are 1..65535 (they travel as a u16 in
   * the binary snapshot) and wrap around, skipping any id still in use — deterministically.
   */
  spawn(entity) {
    let id;
    do {
      id = this.nextId;
      this.nextId = id >= 65535 ? 1 : id + 1;
    } while (this.#entities.has(id));
    entity.id = id;
    this.#entities.set(id, entity);
    return entity;
  }

  /** Deferred removal: step() marks ids here and sweeps them at the end. */
  despawn(id) {
    this.#toDespawn.add(id);
  }

  get(id) {
    return this.#entities.get(id);
  }

  get size() {
    return this.#entities.size;
  }

  [Symbol.iterator]() {
    return this.#entities.values();
  }

  *ofKind(kind) {
    for (const e of this) if (e.kind === kind) yield e;
  }

  /** Records something that happened this tick (shot, hit, explosion) for the snapshot. */
  emit(event) {
    this.events.push(event);
  }

  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ---- building the world -------------------------------------------------------------

  spawnAsteroid(pos, vel, radius = ASTEROID_PARAMS.maxRadius) {
    const spin = (this.rng.next() - 0.5) * ASTEROID_PARAMS.spin;
    return this.spawn(new Asteroid(pos, vel, radius, ASTEROID_PARAMS, spin));
  }

  spawnPickupAt(pos, type = this.rng.chance(0.5) ? PICKUP_KINDS.SHIELD : PICKUP_KINDS.RAPID) {
    return this.spawn(new Pickup(pos, type));
  }

  #randomAsteroidVelocity() {
    const [lo, hi] = this.arena.asteroidSpeed;
    return Vector2.fromAngle(this.rng.next() * TAU, this.rng.range(lo, hi));
  }

  /** The arena's opening state: some asteroids, some homing "hunters", one pickup. */
  populate() {
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
  randomSafeSpot(avoidRadius = 160, awayFromShips = 0) {
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

  addShip(playerId = null) {
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
  applyInput(ship, input, dt) {
    ship.integrate(input, dt);
    if (input.fire) ship.fire(this, input.seq);
  }

  /** One fixed tick of everything that is not a ship's own motion. */
  step(dt) {
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

    this.tick++;
  }
}

function byKind(a, b, kind) {
  if (a.kind === kind) return a;
  if (b.kind === kind) return b;
  return null;
}

/** Collision *resolution*: what happens when two circles overlap. */
function resolvePair(a, b, world) {
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
