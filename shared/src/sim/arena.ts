// The arena is measured in *world units*, independent of canvas size or DPR.
// The simulation never knows how big the window is — that's the renderer's job.

export const ARENA = Object.freeze({ width: 1600, height: 900 });

/** Wraps a coordinate into [0, size). Works for negatives and for huge values. */
export function wrap(v: number, size: number): number {
  return ((v % size) + size) % size;
}

/** Shortest signed distance from a to b on a wrapping axis of length `size`. */
export function wrappedDelta(a: number, b: number, size: number): number {
  let d = b - a;
  if (d > size / 2) d -= size;
  else if (d < -size / 2) d += size;
  return d;
}
