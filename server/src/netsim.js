// A bad network on demand (Lab 5, §7). Localhost has 0 ms latency, zero jitter and never loses
// a packet, so everything *looks* fine there — which is a lie. Each WebSocket connection gets
// two of these links, one per direction, sitting in the server's receive and send paths.
//
//   latency  extra ROUND-TRIP time in ms (each direction adds half of it)
//   jitter   ± ms of random variation on every one-way delay
//   drop     probability 0..1 that a message is lost (as if this were UDP)
//
// Honesty about what this is: a WebSocket rides on TCP, which never loses data and always
// delivers in order. A real lossy link makes TCP *stall* (retransmit); here a dropped message
// simply never arrives, which is how the game would behave over UDP and what the prediction /
// interpolation code must survive. And delivery order IS preserved (a delayed message holds
// up the later ones), like TCP's head-of-line blocking.

export class Link {
  #timers = new Set();
  #lastAt = 0;

  /**
   * @param {object} deps injectable for tests
   * @param {() => number} deps.random  uniform [0,1)
   * @param {() => number} deps.now     ms
   * @param {(fn: Function, ms: number) => any} deps.setTimer
   * @param {(t: any) => void} deps.clearTimer
   */
  constructor({
    random = Math.random,
    now = () => performance.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.random = random;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.latency = 0; // one-way ms
    this.jitter = 0;
    this.drop = 0;
    this.sent = 0;
    this.dropped = 0;
  }

  /** @param {{latency?: number, jitter?: number, drop?: number}} s `latency` here is ONE-WAY */
  configure({ latency = 0, jitter = 0, drop = 0 }) {
    this.latency = latency;
    this.jitter = jitter;
    this.drop = drop;
  }

  get active() {
    return this.latency > 0 || this.jitter > 0 || this.drop > 0 || this.#timers.size > 0;
  }

  /** Runs `deliver` now, later, or never. Returns false if the message was dropped. */
  send(deliver) {
    this.sent++;
    if (!this.active) {
      deliver();
      return true;
    }
    if (this.drop > 0 && this.random() < this.drop) {
      this.dropped++;
      return false;
    }
    const swing = this.jitter > 0 ? (this.random() * 2 - 1) * this.jitter : 0;
    const delay = Math.max(0, this.latency + swing);
    // in-order delivery: never earlier than the message before it (TCP head-of-line blocking)
    const at = Math.max(this.#lastAt, this.now() + delay);
    this.#lastAt = at;
    const wait = Math.max(0, at - this.now());
    if (wait === 0 && this.#timers.size === 0) {
      deliver();
      return true;
    }
    const timer = this.setTimer(() => {
      this.#timers.delete(timer);
      deliver();
    }, wait);
    this.#timers.add(timer);
    return true;
  }

  /** The connection is gone: forget everything still in flight. */
  cancel() {
    for (const t of this.#timers) this.clearTimer(t);
    this.#timers.clear();
  }
}

/** The two directions of one connection, configured together from a RTT-style setting. */
export class NetSim {
  constructor(deps) {
    this.in = new Link(deps); // client → server
    this.out = new Link(deps); // server → client
    this.settings = { latency: 0, jitter: 0, drop: 0 };
  }

  /** @param {{latency: number, jitter: number, drop: number}} s latency = extra round trip */
  configure(s) {
    this.settings = { latency: s.latency, jitter: s.jitter, drop: s.drop };
    const oneWay = { latency: s.latency / 2, jitter: s.jitter, drop: s.drop };
    this.in.configure(oneWay);
    this.out.configure(oneWay);
  }

  cancel() {
    this.in.cancel();
    this.out.cancel();
  }
}
