// World → the logical snapshot message (codec-agnostic: plain numbers, strings and arrays).
// Both codecs turn this same object into bytes; the client's interpolation reads it back.

/**
 * @param {import("./sim/world.js").World} world
 * @param {object} opts
 * @param {number|null} opts.shipId  the ship of the client this snapshot is for (its full state goes in `you`)
 * @param {number} opts.ack          last input seq the server applied for that client
 * @param {object[]} opts.events     what happened during this tick (shared by all clients)
 */
export function buildSnapshot(world, { shipId = null, ack = 0, events = [] } = {}) {
  const snap = {
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
          id: e.id,
          owner: e.owner.id,
          x: e.pos.x,
          y: e.pos.y,
          seq: e.seq & 0xffff,
        });
        break;
      case "asteroid":
        snap.asteroids.push({
          id: e.id,
          x: e.pos.x,
          y: e.pos.y,
          angle: e.angle,
          radius: Math.round(e.radius),
          hunter: Boolean(e.homing),
        });
        break;
      case "pickup":
        snap.pickups.push({ id: e.id, x: e.pos.x, y: e.pos.y, kind: e.type });
        break;
      default:
    }
  }
  return snap;
}
