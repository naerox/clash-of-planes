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
  readonly maxTtl: number;
}

/** What drawParticles wants: position, radius and `life` 1 → 0. */
export interface DrawParticle {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly life: number;
}

export class ParticleSystem {
  #particles: Particle[] = [];

  burst(x: number, y: number, count = 10, random: () => number = Math.random): void {
    for (let i = 0; i < count; i++) {
      const speed = 60 + random() * 180;
      const angle = random() * Math.PI * 2;
      const ttl = 0.3 + random() * 0.3;
      this.#particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: 2 + random() * 2,
        ttl,
        maxTtl: ttl,
      });
    }
  }

  update(dt: number): void {
    for (const p of this.#particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = Math.exp(-3 * dt);
      p.vx *= drag;
      p.vy *= drag;
      p.ttl -= dt;
    }
    this.#particles = this.#particles.filter((p) => p.ttl > 0);
  }

  get list(): DrawParticle[] {
    return this.#particles.map((p) => ({
      x: p.x,
      y: p.y,
      radius: p.radius,
      life: p.ttl / p.maxTtl,
    }));
  }

  get size(): number {
    return this.#particles.length;
  }
}
