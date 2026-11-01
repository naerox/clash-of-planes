// HUD side of the event bus: counts what the sim announces and keeps a short feed.
// Like audio.js, it subscribes from outside — the sim never imports it.

import type { GameBus } from "../events.ts";

const FEED_MS = 2500;

export interface FeedEntry {
  readonly text: string;
  readonly alpha: number;
}

export function createHudFeed(bus: GameBus) {
  const ac = new AbortController();
  const counts = { fired: 0, hits: 0, explosions: 0 };
  const feed: { text: string; at: number }[] = [];
  const slots: { text: string; alpha: number }[] = [];
  const shown: { text: string; alpha: number }[] = [];

  const push = (text: string): void => {
    feed.push({ text, at: performance.now() });
    if (feed.length > 4) feed.shift();
  };

  bus.on("fired", () => counts.fired++, { signal: ac.signal });
  bus.on(
    "hit",
    (e) => {
      counts.hits++;
      push(`hit ${e.target} −${e.damage}`);
    },
    { signal: ac.signal },
  );
  bus.on(
    "exploded",
    (e) => {
      counts.explosions++;
      push(`exploded ${e.kind}`);
    },
    { signal: ac.signal },
  );

  return {
    counts,
    /**
     * Feed entries younger than FEED_MS, with 0..1 opacity for fading out. The array and the
     * entries in it are reused between calls (there are at most four): read them before the next call.
     */
    recent(now = performance.now()): readonly FeedEntry[] {
      shown.length = 0;
      for (let i = 0; i < feed.length; i++) {
        const f = feed[i];
        if (!f || now - f.at >= FEED_MS) continue;
        const entry = slots[shown.length] ?? { text: "", alpha: 0 };
        slots[shown.length] = entry;
        entry.text = f.text;
        entry.alpha = 1 - (now - f.at) / FEED_MS;
        shown.push(entry);
      }
      return shown;
    },
    dispose: () => ac.abort(),
  };
}
