// Pure math helpers. No DOM, no canvas — this folder must run in Node too.

export const TAU = Math.PI * 2;

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export const lerp = (a, b, t) => a + (b - a) * t;

/** Normalises an angle to [-PI, PI). */
export function wrapAngle(a) {
  return a - TAU * Math.floor((a + Math.PI) / TAU);
}

/** Signed shortest rotation from angle a to angle b, in [-PI, PI). */
export function angleDelta(a, b) {
  return wrapAngle(b - a);
}
