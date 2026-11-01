// Numbers that the client and the server must agree on. One definition, imported by both.

export const TICK_RATE = 30; // authoritative simulation steps per second
export const STEP = 1 / TICK_RATE; // the fixed dt of EVERY simulation step, on both sides
export const STEP_MS = 1000 / TICK_RATE;

/** The input stream is limited to a little more than one input per tick on average — enough
 * for clock drift, not enough for a speed hack — with a burst allowance for a late packet
 * that arrives together with the next ones (jitter). */
export const INPUT_RATE_PER_SEC = Math.ceil(TICK_RATE * 1.1);
export const INPUT_BURST = 60;

export const MAX_PLAYERS_PER_MATCH = 8;
