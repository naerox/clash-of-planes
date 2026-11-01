// What a client sends every simulation step: its CONTROLS, never a position.
//
//   { seq, tick, thrust, turn, fire }
//     seq    1, 2, 3, … — the server acknowledges the last one it applied, and the client
//            replays the ones it has not seen acknowledged yet (reconciliation)
//     tick   the newest server tick the client had received when it made this input
//            (for diagnostics today; lag compensation would use it)
//     thrust boolean    turn -1 | 0 | 1    fire boolean
//
// The server never trusts it: a `turn` of 1000 would be a free speed hack, so the shape is
// checked here — the same function validates a JSON input and a decoded binary one.

export const MAX_SEQ = 0xffffffff;

/** @returns {{ok: true, input: object} | {ok: false, reason: string}} */
export function validateInput(raw) {
  if (raw === null || typeof raw !== "object")
    return { ok: false, reason: "input must be an object" };
  const { seq, tick, thrust, turn, fire } = raw;
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ) return { ok: false, reason: "bad seq" };
  if (!Number.isInteger(tick) || tick < 0 || tick > MAX_SEQ)
    return { ok: false, reason: "bad tick" };
  if (typeof thrust !== "boolean") return { ok: false, reason: "thrust must be a boolean" };
  if (typeof fire !== "boolean") return { ok: false, reason: "fire must be a boolean" };
  if (turn !== -1 && turn !== 0 && turn !== 1)
    return { ok: false, reason: "turn must be -1, 0 or 1" };
  return { ok: true, input: { seq, tick, thrust, turn, fire } };
}

/** Limits for the live network simulator (`netsim` message / `?lag=` query). */
export const NETSIM_LIMITS = Object.freeze({ latency: 1000, jitter: 500, drop: 0.5 });

/** @returns {{latency: number, jitter: number, drop: number}} with every field clamped to the limits */
export function clampNetsim(raw) {
  const num = (v, max) => (Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 0);
  return {
    latency: num(raw?.latency, NETSIM_LIMITS.latency),
    jitter: num(raw?.jitter, NETSIM_LIMITS.jitter),
    drop: num(raw?.drop, NETSIM_LIMITS.drop),
  };
}
