// Explosion sparks. Since Lab 5 the simulation lives on the server and knows nothing about
// particles: they are a purely visual effect of an "exploded" event, born on the client, with the
// client's own Math.random() (allowed here — nothing about them is ever sent or predicted).

export class ParticleSystem {
  #particles = [];

  /** @param {number} [count] */
  burst(x, y, count = 10, random = Math.random) {
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

  update(dt) {
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

  /** What drawParticles wants: position, radius and `life` 1 → 0. */
  get list() {
    return this.#particles.map((p) => ({
      x: p.x,
      y: p.y,
      radius: p.radius,
      life: p.ttl / p.maxTtl,
    }));
  }

  get size() {
    return this.#particles.length;
  }
}
