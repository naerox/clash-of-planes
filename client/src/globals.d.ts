// Debug handles that the lab pages hang on `window` so that the console (and the README's
// measurements) can reach them. Optional: they exist only on the page that created them.

import type { BenchResult } from "./lab3/bench.ts";
import type { runDeterminismCheck } from "./lab5/determinism.ts";
import type { GameSession } from "./game/session.ts";
import type { Scene } from "./game/scene.ts";
import type { Connection } from "./net/connection.ts";

declare global {
  interface Window {
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
