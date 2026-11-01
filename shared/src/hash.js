// A fingerprint of the entire simulation state. Two worlds that ran the same inputs from the
// same seed must have the same hash — in Node, in Chrome, today and next year. That is the
// determinism test: if a `Math.random()` or a `Date.now()` ever sneaks into the sim, the hashes
// of two runs differ.
//
// FNV-1a over the raw bytes of every number, so even a 1-ulp difference changes the hash.

const scratch = new DataView(new ArrayBuffer(8));

class Fnv {
  h = 0x811c9dc5;
  byte(b) {
    this.h = Math.imul(this.h ^ b, 0x01000193) >>> 0;
  }
  u32(n) {
    scratch.setUint32(0, n >>> 0, true);
    for (let i = 0; i < 4; i++) this.byte(scratch.getUint8(i));
  }
  f64(n) {
    scratch.setFloat64(0, n, true);
    for (let i = 0; i < 8; i++) this.byte(scratch.getUint8(i));
  }
  str(s) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i) & 0xff);
  }
}

/** @returns {string} 8 hex digits */
export function hashWorld(world) {
  const f = new Fnv();
  f.u32(world.tick);
  f.u32(world.nextId);
  f.u32(world.rng.state);
  for (const e of world) {
    f.u32(e.id);
    f.str(e.kind);
    f.f64(e.pos.x);
    f.f64(e.pos.y);
    f.f64(e.vel.x);
    f.f64(e.vel.y);
    f.f64(e.angle);
    f.byte(e.alive ? 1 : 0);
    if (e.kind === "ship") {
      const s = e.toState();
      for (const k of ["hp", "cooldown", "rapid", "respawn", "score"]) f.f64(s[k]);
    } else if (e.kind === "bullet") {
      f.f64(e.ttl);
      f.u32(e.owner.id);
      f.u32(e.seq);
    } else if (e.kind === "asteroid") {
      f.f64(e.hp);
      f.f64(e.spin);
    } else if (e.kind === "pickup") {
      f.str(e.type);
    }
  }
  return f.h.toString(16).padStart(8, "0");
}
