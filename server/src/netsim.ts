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

/** Everything a Link needs from the outside, injectable so tests need no real clock or timers. */

import { realSchedule, type Schedule } from "./schedule.ts";

export interface LinkDeps {
  /** uniform [0,1) */
  random?: () => number;
  /** ms */
  now?: () => number;
  schedule?: Schedule;
}

export interface LinkSettings {
  readonly latency?: number;
  readonly jitter?: number;
  readonly drop?: number;
}

export class Link {
  #cancels = new Set<() => void>();
  #lastAt = 0;
  readonly random: () => number;
  readonly now: () => number;
  readonly schedule: Schedule;
  latency = 0; // one-way ms
  jitter = 0;
  drop = 0;
  sent = 0;
  dropped = 0;

  constructor({
    random = Math.random,
    now = () => performance.now(),
    schedule = realSchedule,
  }: LinkDeps = {}) {
    this.random = random;
    this.now = now;
    this.schedule = schedule;
  }

  /** `latency` here is ONE-WAY */
  configure({ latency = 0, jitter = 0, drop = 0 }: LinkSettings): void {
    this.latency = latency;
    this.jitter = jitter;
    this.drop = drop;
  }

  get active(): boolean {
    return this.latency > 0 || this.jitter > 0 || this.drop > 0 || this.#cancels.size > 0;
  }

  /** Runs `deliver` now, later, or never. Returns false if the message was dropped. */
  send(deliver: () => void): boolean {
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
    if (wait === 0 && this.#cancels.size === 0) {
      deliver();
      return true;
    }
    const cancel = this.schedule(() => {
      this.#cancels.delete(cancel);
      deliver();
    }, wait);
    this.#cancels.add(cancel);
    return true;
  }

  /** The connection is gone: forget everything still in flight. */
  cancel(): void {
    for (const cancel of this.#cancels) cancel();
    this.#cancels.clear();
  }
}

export interface NetsimSettings {
  readonly latency: number;
  readonly jitter: number;
  readonly drop: number;
}

/** The two directions of one connection, configured together from a RTT-style setting. */
export class NetSim {
  readonly in: Link; // client → server
  readonly out: Link; // server → client
  settings: NetsimSettings = { latency: 0, jitter: 0, drop: 0 };

  constructor(deps?: LinkDeps) {
    this.in = new Link(deps);
    this.out = new Link(deps);
  }

  /** `latency` = extra round trip */
  configure(s: NetsimSettings): void {
    this.settings = { latency: s.latency, jitter: s.jitter, drop: s.drop };
    const oneWay = { latency: s.latency / 2, jitter: s.jitter, drop: s.drop };
    this.in.configure(oneWay);
    this.out.configure(oneWay);
  }

  cancel(): void {
    this.in.cancel();
    this.out.cancel();
  }
}
