// HUD side of the event bus: counts what the sim announces and keeps a short feed.
// Like audio.js, it subscribes from outside — the sim never imports it.

import { GAME_EVENTS } from "../sim/events.js";

const FEED_MS = 2500;

export function createHudFeed(bus) {
  const ac = new AbortController();
  const counts = { fired: 0, hits: 0, explosions: 0 };
  const feed = []; // { text, at }

  const push = (text) => {
    feed.push({ text, at: performance.now() });
    if (feed.length > 4) feed.shift();
  };

  bus.addEventListener(GAME_EVENTS.FIRED, () => counts.fired++, { signal: ac.signal });
  bus.addEventListener(
    GAME_EVENTS.HIT,
    (e) => {
      counts.hits++;
      push(`hit ${e.detail.target} −${e.detail.damage}`);
    },
    { signal: ac.signal },
  );
  bus.addEventListener(
    GAME_EVENTS.EXPLODED,
    (e) => {
      counts.explosions++;
      push(`exploded ${e.detail.kind}`);
    },
    { signal: ac.signal },
  );

  return {
    counts,
    /** Feed entries younger than FEED_MS, with 0..1 opacity for fading out. */
    recent(now = performance.now()) {
      return feed
        .filter((f) => now - f.at < FEED_MS)
        .map((f) => ({ text: f.text, alpha: 1 - (now - f.at) / FEED_MS }));
    },
    dispose: () => ac.abort(),
  };
}
