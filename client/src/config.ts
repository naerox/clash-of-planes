// `public/assets/config/game.json`: fetched at start-up, so it is `unknown` until this schema
// has checked it — a typo in the file fails loudly here, not three layers down as `undefined`.

import { z } from "zod";

const arenaSchema = z.object({
  asteroids: z.number().int().min(0).max(20),
  hunters: z.number().int().min(0).max(6),
  asteroidSpeed: z.tuple([z.number(), z.number()]).readonly(),
});

export const gameConfigSchema = z.object({
  lobby: z.object({ url: z.string(), pollMs: z.number(), timeoutMs: z.number() }),
  audio: z.object({ volume: z.number().min(0).max(1) }).optional(),
  defaultArena: arenaSchema,
  presets: z.array(z.object({ id: z.string(), name: z.string(), arena: arenaSchema })),
});

export type GameConfig = z.infer<typeof gameConfigSchema>;

/** The element with this selector, as the type the caller expects — or a clear error. */
export function requireElement<T extends Element>(
  selector: string,
  type: abstract new (...args: never[]) => T,
): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`index.html has no ${selector}`);
  return found;
}
