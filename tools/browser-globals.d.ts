// What the browser-driving scripts (e2e/, tools/lab07/) may read from `window`. The game's own
// declarations live in client/src/globals.d.ts; this is the slice the outside world looks at.

interface Window {
  /** worker-bench: the bundled codec, and its source text for the Worker */
  codecs?: {
    binaryCodec: { decode(data: Uint8Array, recycler?: unknown): unknown };
    SnapshotRecycler: new () => { release(message: unknown): void };
  };
  __code?: string;
  __net?: {
    session: { shipId: number | null; predictor: unknown };
    lastScene: { ships: { id: number; x: number; y: number; isMe: boolean }[] } | null;
    debug(): { stats: { snapshots: number } };
  };
  __perf?: { report(): unknown; reset(): void };
}

// Chromium-only (behind --enable-precise-memory-info): the JS heap size
interface Performance {
  readonly memory?: { readonly usedJSHeapSize: number };
}
