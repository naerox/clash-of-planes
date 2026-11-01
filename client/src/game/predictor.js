// Client-side prediction and server reconciliation for the local ship (Lab 5, §2–3).
//
//   every sim step:   input = { seq, thrust, turn, fire }
//                     ship.integrate(input)          ← the SAME shared function the server runs
//                     pending.push(input); send(input)       (the ship answers at once)
//
//   a snapshot arrives:  it says "after your input #ack, your ship is HERE"
//                        1. put the ship into that state                      (authority)
//                        2. forget the inputs the server has applied  (seq ≤ ack)
//                        3. re-apply the ones it has not seen yet, in order   (replay)
//                        → the ship is where the server WILL say it is once those inputs land.
//
// If prediction was right, step 3 lands on the position we already had: the "correction" is 0
// and nothing visible happens. If the server disagreed (a collision we cannot predict, a
// respawn, a bug that broke determinism) the ship jumps — and the jump is not drawn as a jump:
// it is turned into a visual OFFSET that melts away in ~100 ms (see `decay`).

import { ARENA, BULLET_PARAMS, Bullet, STEP, Ship, wrap, wrappedDelta } from "@dogfight/shared";

/** Above this much error (a respawn teleport) smoothing would just drag the ship across the arena. */
export const SNAP_DISTANCE = 120;
const MAX_PENDING = 300;

export class Predictor {
  /**
   * @param {object} opts
   * @param {object} opts.state       the server's state of our ship (`you` from the first snapshot)
   * @param {number} [opts.chaos]     EXPERIMENT: multiplicative noise injected into every predicted
   *                                  step — a stand-in for "Math.random() inside integrate", which the
   *                                  shared sim forbids (see README: the determinism-break experiment)
   * @param {() => number} [opts.random] noise source for `chaos`
   */
  constructor({ state, chaos = 0, random = Math.random }) {
    this.ship = Ship.fromState(state);
    this.chaos = chaos;
    this.random = random;
    this.pending = []; // inputs sent and not yet acknowledged
    this.bullets = []; // predicted bullets, drawn immediately
    this.offset = { x: 0, y: 0 }; // visual correction, decays to 0
    this.offsetVel = { x: 0, y: 0 }; // …with the spring's velocity (see decay)
    this.lastCorrection = 0; // size of the most recent reconciliation error, in world units
    this.corrections = 0;
  }

  /**
   * One prediction step for an input that is about to be sent (the caller numbers it).
   * Returns the shot (if this step fired a bullet) so the caller can announce it at once.
   */
  step(input) {
    this.#advanceBullets();
    const shot = this.#apply(input, true);
    this.pending.push(input);
    // While the link is down no acknowledgement ever arrives: do not remember inputs forever
    // (10 s is far more than any reconnect we would still try to reconcile across).
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    return shot;
  }

  /** The same step the server will perform for this input. `spawn`: false while replaying. */
  #apply(input, spawn) {
    this.ship.integrate(input, STEP);
    if (this.chaos > 0) {
      this.ship.vel = this.ship.vel.scale(1 + (this.random() - 0.5) * this.chaos);
    }
    if (!input.fire) return null;
    const shot = this.ship.tryFire();
    if (shot && spawn) {
      const bullet = new Bullet(shot.pos, shot.vel, this.ship, BULLET_PARAMS, input.seq);
      bullet.prevPos = bullet.pos;
      bullet.id = -input.seq; // local until the server's copy is seen
      this.bullets.push(bullet);
    }
    return shot;
  }

  #advanceBullets() {
    for (const b of this.bullets) {
      b.prevPos = b.pos;
      b.update(STEP);
    }
    this.bullets = this.bullets.filter((b) => b.alive);
  }

  /**
   * Apply the server's word about our ship.
   * @param {object} you           snapshot.you (full state at server tick `tick`)
   * @param {number} ack           last input seq the server applied
   * @param {object[]} serverBullets  the snapshot's bullet list (to recognise our own shots)
   * @returns {number} the correction in world units (how wrong the prediction was)
   */
  reconcile(you, ack, serverBullets = []) {
    const before = this.ship.pos;
    this.ship.setState(you);
    this.pending = this.pending.filter((input) => input.seq > ack);
    this.ship.prevPos = this.ship.pos; // if there is nothing to replay, we are exactly here
    this.ship.prevAngle = this.ship.angle;
    for (const input of this.pending) this.#apply(input, false); // replay

    const after = this.ship.pos;
    const dx = wrappedDelta(after.x, before.x, ARENA.width);
    const dy = wrappedDelta(after.y, before.y, ARENA.height);
    const error = Math.hypot(dx, dy);
    this.lastCorrection = error;
    this.corrections++;
    if (error > SNAP_DISTANCE) {
      this.offset = { x: 0, y: 0 };
      this.offsetVel = { x: 0, y: 0 };
    } else {
      // the ship is now at `after`, but the player has been looking at `before`: draw it
      // where it was and let the difference fade, instead of snapping
      this.offset = { x: this.offset.x + dx, y: this.offset.y + dy };
    }
    this.#matchBullets(you.id, ack, serverBullets);
    return error;
  }

  /**
   * Our predicted bullets vs the server's. The server's copy of OUR bullet carries the seq of the
   * input that fired it, so we recognise it. A predicted bullet disappears when:
   *   - the server has a copy and then stops having it (it hit something / expired), or
   *   - the server has already processed its input (seq ≤ ack) and made no bullet (cooldown, dead).
   */
  #matchBullets(shipId, ack, serverBullets) {
    const mine = new Map();
    for (const b of serverBullets) if (b.owner === shipId) mine.set(b.seq, b);
    for (const b of this.bullets) {
      const server = mine.get(b.seq & 0xffff);
      if (server) {
        b.confirmed = true;
        b.id = server.id;
      } else if (b.confirmed || b.seq <= ack) {
        b.alive = false;
      }
    }
    this.bullets = this.bullets.filter((b) => b.alive);
  }

  /**
   * Melt the visual offset with a critically damped spring (the "smooth damp" every game
   * engine has). Compared with a plain exponential decay it does not START with a big step —
   * the first frame moves the ship by a few percent of the error, speeds up, then eases out —
   * so the correction looks like the ship steering, not like being shoved.
   *
   * `smoothMs` is the time after which less than 5% of the error is left. For a critically
   * damped spring x(t) = (1 + ωt)e^(−ωt), that is ωt ≈ 4.74.
   */
  decay(frameMs, smoothMs) {
    if (smoothMs <= 0) {
      this.offset = { x: 0, y: 0 };
      this.offsetVel = { x: 0, y: 0 };
      return;
    }
    const omega = 4.74 / smoothMs; // 1/ms
    const x = omega * frameMs;
    const damp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x); // Padé approximation of e^−x
    const v = this.offsetVel;
    const axis = (offset, vel) => {
      const temp = (vel + omega * offset) * frameMs;
      return [(offset + temp) * damp, (vel - omega * temp) * damp];
    };
    const [nx, vx] = axis(this.offset.x, v.x);
    const [ny, vy] = axis(this.offset.y, v.y);
    this.offset = { x: nx, y: ny };
    this.offsetVel = { x: vx, y: vy };
    if (Math.abs(nx) + Math.abs(ny) + Math.abs(vx) + Math.abs(vy) < 1e-4) {
      this.offset = { x: 0, y: 0 };
      this.offsetVel = { x: 0, y: 0 };
    }
  }

  /** Where to draw the ship: the interpolated pose between the last two steps, plus the fading offset. */
  visual(alpha) {
    const { ship } = this;
    const prev = ship.prevPos ?? ship.pos;
    const x = prev.x + wrappedDelta(prev.x, ship.pos.x, ARENA.width) * alpha + this.offset.x;
    const y = prev.y + wrappedDelta(prev.y, ship.pos.y, ARENA.height) * alpha + this.offset.y;
    const pa = ship.prevAngle ?? ship.angle;
    let da = ship.angle - pa;
    da -= Math.PI * 2 * Math.round(da / (Math.PI * 2));
    return { x: wrap(x, ARENA.width), y: wrap(y, ARENA.height), angle: pa + da * alpha };
  }
}
