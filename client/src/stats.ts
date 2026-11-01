// Rolling one-second window of loop metrics, exposed as a plain object the HUD can read.

export interface LoopStats {
  stepsPerSec: number;
  framesPerSec: number;
  frameMs: number;
  deltaMs: number;
  jitterMs: number;
  maxDeltaMs: number;
}

export function createStats(windowMs = 1000) {
  const snapshot: LoopStats = {
    stepsPerSec: 0,
    framesPerSec: 0,
    frameMs: 0,
    deltaMs: 0,
    jitterMs: 0,
    maxDeltaMs: 0,
  };

  let windowStart: number | null = null;
  let steps = 0;
  let frames = 0;
  let sum = 0;
  let sumSq = 0;
  let max = 0;

  return {
    snapshot,
    countStep(): void {
      steps++;
    },
    countFrame(now: number, deltaMs: number, workMs: number): void {
      snapshot.frameMs = workMs;
      snapshot.deltaMs = deltaMs;

      if (windowStart === null) {
        windowStart = now;
        return;
      }

      frames++;
      sum += deltaMs;
      sumSq += deltaMs * deltaMs;
      if (deltaMs > max) max = deltaMs;

      const elapsed = now - windowStart;
      if (elapsed >= windowMs) {
        const mean = sum / frames;
        snapshot.stepsPerSec = (steps * 1000) / elapsed;
        snapshot.framesPerSec = (frames * 1000) / elapsed;
        snapshot.jitterMs = Math.sqrt(Math.max(0, sumSq / frames - mean * mean));
        snapshot.maxDeltaMs = max;
        windowStart = now;
        steps = frames = 0;
        sum = sumSq = max = 0;
      }
    },
  };
}
