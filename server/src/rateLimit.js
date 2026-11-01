// Token bucket: holds up to `capacity` tokens, refilled at `perSec`. A message costs one
// token; with none left the message is over the limit. Short bursts pass, a sustained
// flood does not — which is the difference from a fixed "N per second" window.

export class TokenBucket {
  #capacity;
  #perSec;
  #now;
  #tokens;
  #last;

  constructor({ capacity, perSec, now = () => performance.now() }) {
    this.#capacity = capacity;
    this.#perSec = perSec;
    this.#now = now;
    this.#tokens = capacity;
    this.#last = now();
  }

  take(cost = 1) {
    const t = this.#now();
    this.#tokens = Math.min(
      this.#capacity,
      this.#tokens + ((t - this.#last) / 1000) * this.#perSec,
    );
    this.#last = t;
    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }
}
