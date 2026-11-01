// A fingerprint of the entire simulation state. Two worlds that ran the same inputs from the
// same seed must have the same hash — in Node, in Chrome, today and next year. That is the
// determinism test: if a `Math.random()` or a `Date.now()` ever sneaks into the sim, the hashes
// of two runs differ.
//
// FNV-1a over the raw bytes of every number, so even a 1-ulp difference changes the hash.

import type { World } from "./sim/world.ts";

const scratch = new DataView(new ArrayBuffer(8));

class Fnv {
  h = 0x811c9dc5;
  byte(b: number): void {
    this.h = Math.imul(this.h ^ b, 0x01000193) >>> 0;
  }
  u32(n: number): void {
    scratch.setUint32(0, n >>> 0, true);
    for (let i = 0; i < 4; i++) this.byte(scratch.getUint8(i));
  }
  f64(n: number): void {
    scratch.setFloat64(0, n, true);
    for (let i = 0; i < 8; i++) this.byte(scratch.getUint8(i));
  }
  str(s: string): void {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i) & 0xff);
  }
}

/** @returns 8 hex digits */
export function hashWorld(world: World): string {
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
    switch (e.kind) {
      case "ship": {
        const s = e.toState();
        for (const v of [s.hp, s.cooldown, s.rapid, s.respawn, s.score]) f.f64(v);
        break;
      }
      case "bullet":
        f.f64(e.ttl);
        f.u32(e.owner.id);
        f.u32(e.seq);
        break;
      case "asteroid":
        f.f64(e.hp);
        f.f64(e.spin);
        break;
      case "pickup":
        f.str(e.type);
        break;
      default: {
        const unreachable: never = e;
        return unreachable;
      }
    }
  }
  return f.h.toString(16).padStart(8, "0");
}
