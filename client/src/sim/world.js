import { Vector2 } from "./vector.js";
import { ARENA, wrap } from "./arena.js";
import { findCollisions } from "./collision.js";
import { applyHoming } from "./homing.js";
import { makeExplosionParticles } from "./explosion.js";
import { Pickup, PICKUP_KINDS, PICKUP_PARAMS } from "./pickup.js";
import { ASTEROID_CONTACT_DAMAGE } from "./asteroid.js";
import { EventBus, GAME_EVENTS } from "./events.js";

/**
 * The entity store and the step function, in one place. `#entities` is a private
 * `Map<id, Entity>` (Section 4 of the lab) rather than a plain object: entity ids are
 * numbers and stay numbers, `.size` is real, insertion order is guaranteed, and there
 * is no risk of colliding with an inherited key the way `entities["constructor"]` can.
 */
export class World {
  #entities = new Map();
  #toDespawn = new Set(); // deferred: step() marks ids here, sweeps them at the end
  #pickupTimer = PICKUP_PARAMS.respawnDelay;

  /** `events` is injected (Lab 3): main.js passes the shared bus that audio and the HUD
   * listen to; tests can pass their own or ignore it. */
  constructor({ events = new EventBus() } = {}) {
    this.events = events;
  }

  spawn(entity) {
    this.#entities.set(entity.id, entity);
    return entity;
  }

  /** Deferred removal: mutating a Map mid-iteration is *legal* in JS, but doing it from
   * inside collision resolution (itself iterating a snapshot) is exactly the kind of
   * subtle-bug shape the lab warns about, so we only ever mark-and-sweep. */
  despawn(id) {
    this.#toDespawn.add(id);
  }

  get(id) {
    return this.#entities.get(id);
  }

  get size() {
    return this.#entities.size;
  }

  // Makes `for (const e of world)` and `[...world]` work directly on the World instance.
  [Symbol.iterator]() {
    return this.#entities.values();
  }

  /** A generator, not a method that builds and returns an array: `world.ofKind("bullet")`
   * never allocates more than one entity's worth of state at a time, and a `for...of`
   * consumer can `break` early without the generator doing any wasted work. */
  *ofKind(kind) {
    for (const e of this) if (e.kind === kind) yield e;
  }

  spawnExplosion(pos, source) {
    for (const p of makeExplosionParticles(pos)) this.spawn(p);
    if (source) {
      this.events.emit(GAME_EVENTS.EXPLODED, {
        kind: source.kind,
        id: source.id,
        pos,
        radius: source.radius,
      });
    }
  }

  spawnPickupAt(pos, type = Math.random() < 0.5 ? PICKUP_KINDS.SHIELD : PICKUP_KINDS.RAPID) {
    return this.spawn(new Pickup(pos, type));
  }

  /** A spot at least `avoidRadius` from every current asteroid — used for ship respawn
   * and for placing new pickups so they don't spawn inside a rock. */
  randomSafeSpot(avoidRadius = 160) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const pos = new Vector2(Math.random() * ARENA.width, Math.random() * ARENA.height);
      let safe = true;
      for (const a of this.ofKind("asteroid")) {
        if (pos.sub(a.pos).length() < avoidRadius + a.radius) {
          safe = false;
          break;
        }
      }
      if (safe) return pos;
    }
    return new Vector2(ARENA.width / 2, ARENA.height / 2);
  }

  /**
   * One fixed tick: move everything, resolve collisions, sweep the dead. `controls` is
   * this tick's input, applied to every `ship`-kind entity — today that's one local ship;
   * Lab 5 generalises this to a `Map<shipId, controls>` once input arrives over the wire.
   */
  step(dt, controls) {
    for (const e of this) {
      if (!e.alive) continue;
      // Captured BEFORE update() runs. Because Vector2 methods never mutate `this`,
      // `e.pos = e.pos.add(...)` inside update() replaces the reference rather than
      // changing it in place — so the value we stash here stays exactly what it was,
      // giving the renderer a free "previous state" for interpolation (Lab 1, M3) with
      // no extra bookkeeping, for every entity kind, not just the ship.
      e.prevPos = e.pos;
      e.prevAngle = e.angle;

      if (e.homing) applyHoming(e, dt);
      if (e.kind === "ship") e.update(dt, controls, this);
      else e.update(dt);

      if (e.kind === "ship" && !e.isDead) {
        e.pos = new Vector2(wrap(e.pos.x, ARENA.width), wrap(e.pos.y, ARENA.height));
      }
    }

    for (const [a, b] of findCollisions(this)) resolvePair(a, b, this);

    for (const e of this) if (!e.alive) this.#toDespawn.add(e.id);
    for (const id of this.#toDespawn) this.#entities.delete(id);
    this.#toDespawn.clear();

    this.#pickupTimer -= dt;
    if (this.#pickupTimer <= 0) {
      this.spawnPickupAt(this.randomSafeSpot());
      this.#pickupTimer = PICKUP_PARAMS.respawnDelay;
    }
  }
}

function byKind(a, b, kind) {
  if (a.kind === kind) return a;
  if (b.kind === kind) return b;
  return null;
}

/** Collision *resolution*: what happens when two circles overlap. Kept separate from
 * `findCollisions` (pure geometry) so the "what hits what" game rules live in one place. */
function resolvePair(a, b, world) {
  const bullet = byKind(a, b, "bullet");
  const ship = byKind(a, b, "ship");
  const asteroid = byKind(a, b, "asteroid");
  const pickup = byKind(a, b, "pickup");

  if (bullet && ship && bullet.owner !== ship && !ship.isDead) {
    const wasAlive = ship.hp > 0;
    ship.takeDamage(bullet.damage, world);
    bullet.alive = false;
    world.events.emit(GAME_EVENTS.HIT, {
      target: "ship",
      targetId: ship.id,
      pos: bullet.pos,
      damage: bullet.damage,
    });
    if (wasAlive && ship.hp === 0) bullet.owner.score++;
    return;
  }
  if (bullet && asteroid) {
    asteroid.hp -= bullet.damage;
    bullet.alive = false;
    world.events.emit(GAME_EVENTS.HIT, {
      target: "asteroid",
      targetId: asteroid.id,
      pos: bullet.pos,
      damage: bullet.damage,
    });
    if (asteroid.hp <= 0) {
      asteroid.alive = false;
      world.spawnExplosion(asteroid.pos, asteroid);
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
