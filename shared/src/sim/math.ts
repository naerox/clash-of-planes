// Pure math helpers. No DOM, no canvas — this folder must run in Node too.

export const TAU = Math.PI * 2;

export const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Normalises an angle to [-PI, PI). */
export function wrapAngle(a: number): number {
  return a - TAU * Math.floor((a + Math.PI) / TAU);
}

/** Signed shortest rotation from angle a to angle b, in [-PI, PI). */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}
