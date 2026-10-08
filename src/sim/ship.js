import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";
import { wrapAngle } from "./math.js";
import { Bullet } from "./bullet.js";

export const SHIP_PARAMS = Object.freeze({
  turnRate: 3.6, // rad/s at full turn input
  thrust: 320, // acceleration, units/s²
  drag: 0.7, // 1/s, exponential velocity decay (independent of dt)
  maxSpeed: 420, // units/s
  radius: 18,
  maxHp: 100,
  fireCooldown: 0.25, // s between shots
  respawnDelay: 2, // s — Definition of done asks for exactly this
});

/**
 * One level of `extends` (Entity → Ship), as the lab asks for — no deeper. Everything
 * a ship can additionally do (shoot, take damage, respawn) lives here as methods;
 * anything a ship shares with non-ship things (homing, being a pickup target) is
 * composition instead, in homing.js and the World, not further subclassing.
 */
export class Ship extends Entity {
  // Private field: nothing outside this class can read or write #hp directly. The
  // public `get hp()` below is the only way out — a deliberately narrow window,
  // the same idea as a closure's private variables in Lab 1's createInput().
  #hp = SHIP_PARAMS.maxHp;
  #cooldown = 0;
  #respawnTimer = 0;

  kind = "ship";

  constructor(pos, params = SHIP_PARAMS) {
    super(pos, Vector2.zero, { angle: -Math.PI / 2, radius: params.radius });
    this.params = params;
    this.thrusting = false;
    this.score = 0;
    this.rapidTimer = 0; // >0 while a "rapid fire" pickup is active (public: no invariant to protect)
  }

  get hp() {
    return this.#hp;
  }

  get isDead() {
    return this.#respawnTimer > 0;
  }

  /**
   * Pure-ish step: same shape as Lab 1's `integrate`, but now an instance method so it
   * can read `this.params` and write `this.pos`/`this.vel` directly instead of returning
   * a new object. World.step() calls this once per fixed tick for every live ship.
   */
  update(dt, controls, world) {
    if (this.#respawnTimer > 0) {
      this.#respawnTimer = Math.max(0, this.#respawnTimer - dt);
      if (this.#respawnTimer === 0) this.respawnAt(world.randomSafeSpot());
      return;
    }
    if (this.#cooldown > 0) this.#cooldown -= dt;
    if (this.rapidTimer > 0) this.rapidTimer -= dt;

    const p = this.params;
    this.angle = wrapAngle(this.angle + controls.turn * p.turnRate * dt);
    this.thrusting = controls.thrust;

    let vel = this.vel;
    if (controls.thrust) {
      vel = vel.add(Vector2.fromAngle(this.angle, p.thrust * dt));
    }
    vel = vel.scale(Math.exp(-p.drag * dt)); // exponential drag — independent of dt slicing
    const speed = vel.length();
    if (speed > p.maxSpeed) vel = vel.scale(p.maxSpeed / speed);
    this.vel = vel;

    this.pos = this.pos.add(vel.scale(dt));
  }

  /**
   * Spawns a bullet from the ship's nose, inheriting the ship's velocity. Called
   * directly as `ship.fire(world)` from `main.js` — implicit binding (Section 2, rule 3:
   * `obj.f()` binds `this` to `obj`), so `this` inside is correct by construction. This
   * is the method the lab warns about: `addEventListener("keydown", ship.fire)` would
   * instead call it as a bare function, losing that binding. See `experiments.js`
   * (`runBugDemo`) for a live, isolated reproduction of exactly that failure and three
   * fixes for it.
   */
  fire(world) {
    if (this.#cooldown > 0 || this.isDead) return null;
    this.#cooldown = this.rapidTimer > 0 ? this.params.fireCooldown / 2 : this.params.fireCooldown;
    const nose = this.pos.add(Vector2.fromAngle(this.angle, this.radius));
    const muzzle = Vector2.fromAngle(this.angle, 480);
    const bullet = new Bullet(nose, this.vel.add(muzzle), this);
    return world.spawn(bullet);
  }

  takeDamage(amount, world) {
    if (this.isDead) return;
    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp === 0) this.die(world);
  }

  die(world) {
    this.#respawnTimer = this.params.respawnDelay;
    this.vel = Vector2.zero;
    world.spawnExplosion(this.pos);
  }

  respawnAt(pos) {
    this.pos = pos;
    this.vel = Vector2.zero;
    this.#hp = this.params.maxHp;
    this.#respawnTimer = 0;
  }

  /** Pickup effects live here, not in World, so `#hp` stays private: World can only ask
   * the ship to apply a pickup, never reach in and set the field itself. */
  applyPickup(type) {
    if (type === "shield") this.#hp = Math.min(this.params.maxHp, this.#hp + 40);
    else if (type === "rapid") this.rapidTimer = 6;
  }
}
