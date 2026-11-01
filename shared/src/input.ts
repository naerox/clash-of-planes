// What a client sends every simulation step: its CONTROLS, never a position.
//
//   { seq, tick, thrust, turn, fire }
//     seq    1, 2, 3, … — the server acknowledges the last one it applied, and the client
//            replays the ones it has not seen acknowledged yet (reconciliation)
//     tick   the newest server tick the client had received when it made this input
//            (for diagnostics today; lag compensation would use it)
//     thrust boolean    turn -1 | 0 | 1    fire boolean
//
// The server never trusts it: a `turn` of 1000 would be a free speed hack. Since Lab 6 the
// shape is a Zod schema (protocol.ts) for JSON frames, and the binary decoder checks the same
// ranges itself while it reads the bytes — there is no hand-written validator any more.

import type { Seq, Tick } from "./brand.ts";

export const MAX_SEQ = 0xffffffff;

export type Turn = -1 | 0 | 1;

/** What steers a ship for one step. */
export interface Controls {
  readonly turn: Turn;
  readonly thrust: boolean;
}

/** One input message, as the server receives it. */
export interface InputCommand extends Controls {
  readonly seq: Seq;
  readonly tick: Tick;
  readonly fire: boolean;
}

export interface NetsimSettings {
  readonly latency: number;
  readonly jitter: number;
  readonly drop: number;
}

/** Limits for the live network simulator (`netsim` message / `?lag=` query). */
export const NETSIM_LIMITS: NetsimSettings = Object.freeze({
  latency: 1000,
  jitter: 500,
  drop: 0.5,
});

/** Every field clamped to the limits; anything that is not a finite number becomes 0. */
export function clampNetsim(raw: Partial<Record<keyof NetsimSettings, number>>): NetsimSettings {
  const num = (v: number | undefined, max: number): number =>
    v !== undefined && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 0;
  return {
    latency: num(raw.latency, NETSIM_LIMITS.latency),
    jitter: num(raw.jitter, NETSIM_LIMITS.jitter),
    drop: num(raw.drop, NETSIM_LIMITS.drop),
  };
}
