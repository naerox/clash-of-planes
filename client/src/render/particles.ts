// Explosion sparks. Since Lab 5 the simulation lives on the server and knows nothing about
// particles: they are a purely visual effect of an "exploded" event, born on the client, with the
// client's own Math.random() (allowed here — nothing about them is ever sent or predicted).

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  ttl: number;
  maxTtl: number;
  /** 1 → 0, kept up to date by `update` so drawing needs no object of its own. */
  life: number;
}

/** What drawParticles wants: position, radius and `life` 1 → 0. */
export interface DrawParticle {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly life: number;
}

const blank = (): Particle => ({ x: 0, y: 0, vx: 0, vy: 0, radius: 0, ttl: 0, maxTtl: 1, life: 1 });

/**
 * A pool: sparks are recycled instead of allocated. A dead spark goes on the free list and the
 * next burst rewrites it, so after the first few explosions nothing is created or collected.
 * (Before: a new object per spark, a new array per frame from `filter`, and another from `map`.)
 */
export class ParticleSystem {
  readonly #live: Particle[] = [];
  readonly #free: Particle[] = [];

  burst(x: number, y: number, count = 10, random: () => number = Math.random): void {
    for (let i = 0; i < count; i++) {
      const speed = 60 + random() * 180;
      const angle = random() * Math.PI * 2;
      const ttl = 0.3 + random() * 0.3;
      const p = this.#free.pop() ?? blank();
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.radius = 2 + random() * 2;
      p.ttl = ttl;
      p.maxTtl = ttl;
      p.life = 1;
      this.#live.push(p);
    }
  }

  update(dt: number): void {
    const live = this.#live;
    const drag = Math.exp(-3 * dt);
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      if (!p) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= drag;
      p.vy *= drag;
      p.ttl -= dt;
      p.life = p.ttl / p.maxTtl;
      if (p.ttl <= 0) {
        const last = live.pop();
        if (last && last !== p) live[i] = last; // swap-remove: order does not matter
        this.#free.push(p);
      }
    }
  }

  /** The live sparks themselves (not a copy): read them, do not keep them. */
  get list(): readonly DrawParticle[] {
    return this.#live;
  }

  get size(): number {
    return this.#live.length;
  }
}
