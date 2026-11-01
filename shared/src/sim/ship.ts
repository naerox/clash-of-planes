import { NO_SEQ, type EntityId, type Seq } from "../brand.ts";
import type { Controls } from "../input.ts";
import { Entity } from "./entity.ts";
import type { PickupType } from "./pickup.ts";
import type { World } from "./world.ts";
import { Vector2 } from "./vector.ts";
import { wrapAngle } from "./math.ts";
import { ARENA, wrap } from "./arena.ts";
import { Bullet, BULLET_PARAMS } from "./bullet.ts";

export interface ShipParams {
  readonly turnRate: number;
  readonly thrust: number;
  readonly drag: number;
  readonly maxSpeed: number;
  readonly radius: number;
  readonly maxHp: number;
  readonly fireCooldown: number;
  readonly respawnDelay: number;
}

export const SHIP_PARAMS: ShipParams = Object.freeze({
  turnRate: 3.6, // rad/s at full turn input
  thrust: 320, // acceleration, units/s²
  drag: 0.7, // 1/s, exponential velocity decay (independent of dt)
  maxSpeed: 420, // units/s
  radius: 18,
  maxHp: 100,
  fireCooldown: 0.25, // s between shots
  respawnDelay: 2, // s
});

export const MUZZLE_SPEED = 480;

/** The plain-data form of a ship that a snapshot carries (`you`) and `setState` accepts. */
export interface ShipState {
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly hp: number;
  readonly cooldown: number;
  readonly rapid: number;
  readonly respawn: number;
  readonly score: number;
  readonly thrusting: boolean;
}

/** Where a bullet would start, and how fast it flies. */
export interface Shot {
  readonly pos: Vector2;
  readonly vel: Vector2;
}

/**
 * One level of `extends` (Entity → Ship), as in Lab 2. Lab 5 splits what a ship does into
 * pieces that the CLIENT can also run:
 *
 *   integrate(controls, dt)  — the movement function ("Lab 1's integrate"). Driven by INPUTS,
 *                              not by the world clock: a ship advances one step per input it
 *                              receives, so server and client replay exactly the same steps.
 *   tryFire()                — cooldown bookkeeping + "where would a bullet start"; spawns
 *                              nothing, so the client can use it for prediction too.
 *   tickRespawn(dt, world)   — time-driven, server only (picking a respawn point needs the
 *                              world's seeded random stream).
 *   toState()/setState()     — the plain-data form a snapshot carries, and how the client
 *                              puts its predicted ship back into the server's state.
 */
export class Ship extends Entity {
  // Private fields (Lab 2): nothing outside can write them. The public way in is
  // `setState`, which lives inside the class and therefore may.
  #hp: number = SHIP_PARAMS.maxHp;
  #cooldown = 0;
  #respawnTimer = 0;

  readonly kind = "ship";
  readonly params: ShipParams;
  thrusting = false;
  score = 0;
  rapidTimer = 0; // >0 while a "rapid fire" pickup is active
  playerId: string | null = null; // set by the server: which player flies this ship

  constructor(pos?: Vector2, params: ShipParams = SHIP_PARAMS) {
    super(pos, Vector2.zero, { angle: -Math.PI / 2, radius: params.radius });
    this.params = params;
  }

  get hp(): number {
    return this.#hp;
  }

  get isDead(): boolean {
    return this.#respawnTimer > 0;
  }

  get cooldown(): number {
    return this.#cooldown;
  }

  get respawnTimer(): number {
    return this.#respawnTimer;
  }

  /**
   * Advance this ship by ONE fixed step under `controls` ({ turn: -1..1, thrust: bool }).
   * Pure function of (state, controls, dt): no clock, no randomness, no world.
   */
  integrate(controls: Controls, dt: number): void {
    this.prevPos = this.pos; // for render interpolation between steps (Lab 1)
    this.prevAngle = this.angle;
    if (this.isDead) {
      this.thrusting = false;
      return;
    }
    if (this.#cooldown > 0) this.#cooldown = Math.max(0, this.#cooldown - dt);
    if (this.rapidTimer > 0) this.rapidTimer = Math.max(0, this.rapidTimer - dt);

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

    const next = this.pos.add(vel.scale(dt));
    this.pos = new Vector2(wrap(next.x, ARENA.width), wrap(next.y, ARENA.height)); // the arena wraps
  }

  /** Starts the cooldown and returns where a bullet would start, or null (dead / cooling). */
  tryFire(): Shot | null {
    if (this.#cooldown > 0 || this.isDead) return null;
    this.#cooldown = this.rapidTimer > 0 ? this.params.fireCooldown / 2 : this.params.fireCooldown;
    const nose = this.pos.add(Vector2.fromAngle(this.angle, this.radius));
    const muzzle = Vector2.fromAngle(this.angle, MUZZLE_SPEED);
    return { pos: nose, vel: this.vel.add(muzzle) };
  }

  /**
   * Fires into `world`. Called directly as `ship.fire(world)` — implicit binding, so `this` is
   * correct by construction; `addEventListener("click", ship.fire)` would lose it (Lab 2).
   */
  fire(world: World, seq: Seq = NO_SEQ): Bullet | null {
    const shot = this.tryFire();
    if (!shot) return null;
    const bullet = world.spawn(new Bullet(shot.pos, shot.vel, this, BULLET_PARAMS, seq));
    world.emit({ type: "fired", shooterId: this.id, x: shot.pos.x, y: shot.pos.y });
    return bullet;
  }

  takeDamage(amount: number, world: World): void {
    if (this.isDead) return;
    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp === 0) this.die(world);
  }

  die(world: World): void {
    this.#respawnTimer = this.params.respawnDelay;
    this.vel = Vector2.zero;
    this.thrusting = false;
    world.emit({
      type: "exploded",
      kind: "ship",
      id: this.id,
      x: this.pos.x,
      y: this.pos.y,
      radius: this.radius,
    });
  }

  /** Time-driven part of dying: count down, then come back somewhere safe. */
  tickRespawn(dt: number, world: World): void {
    if (this.#respawnTimer <= 0) return;
    this.#respawnTimer = Math.max(0, this.#respawnTimer - dt);
    if (this.#respawnTimer === 0) this.respawnAt(world.randomSafeSpot(160, 250));
  }

  respawnAt(pos: Vector2): void {
    this.pos = pos;
    this.prevPos = pos;
    this.vel = Vector2.zero;
    this.#hp = this.params.maxHp;
    this.#respawnTimer = 0;
    this.#cooldown = 0;
    this.rapidTimer = 0;
  }

  /** Pickup effects live here, not in World, so `#hp` stays private. */
  applyPickup(type: PickupType): void {
    if (type === "shield") this.#hp = Math.min(this.params.maxHp, this.#hp + 40);
    else if (type === "rapid") this.rapidTimer = 6;
  }

  /** Everything that decides what this ship does next, as plain numbers. */
  toState(): ShipState {
    return {
      id: this.id,
      x: this.pos.x,
      y: this.pos.y,
      vx: this.vel.x,
      vy: this.vel.y,
      angle: this.angle,
      hp: this.#hp,
      cooldown: this.#cooldown,
      rapid: this.rapidTimer,
      respawn: this.#respawnTimer,
      score: this.score,
      thrusting: this.thrusting,
    };
  }

  /** Overwrites this ship with `state` (the server's word about it). Keeps `id`. */
  setState(s: ShipState): void {
    this.pos = new Vector2(s.x, s.y);
    this.vel = new Vector2(s.vx, s.vy);
    this.angle = s.angle;
    this.#hp = s.hp;
    this.#cooldown = s.cooldown;
    this.rapidTimer = s.rapid;
    this.#respawnTimer = s.respawn;
    this.score = s.score;
    this.thrusting = s.thrusting;
  }

  static fromState(state: ShipState): Ship {
    const ship = new Ship(new Vector2(state.x, state.y));
    ship.id = state.id;
    ship.setState(state);
    ship.prevPos = ship.pos;
    ship.prevAngle = ship.angle;
    return ship;
  }
}
