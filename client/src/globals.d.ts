// Debug handles that the lab pages hang on `window` so that the console (and the README's
// measurements) can reach them. Optional: they exist only on the page that created them.

import type { BenchResult } from "./lab3/bench.ts";
import type { runDeterminismCheck } from "./lab5/determinism.ts";
import type { GameSession } from "./game/session.ts";
import type { Scene } from "./game/scene.ts";
import type { Connection } from "./net/connection.ts";

declare global {
  /** Stamped by vite.config.ts at build time. */
  const __APP_VERSION__: string | undefined;
  const __GIT_SHA__: string | undefined;

  interface Window {
    /** Allocation-free timing of the hot paths (perf.ts); `?trace=1` also feeds DevTools. */
    __perf?: typeof import("./perf.ts");
    __bench?: BenchResult;
    __determinism?: ReturnType<typeof runDeterminismCheck>;
    __net?: {
      session: GameSession;
      debug: () => ReturnType<GameSession["debug"]>;
      connection: Connection;
      lastScene: Scene | null;
    };
  }
}
