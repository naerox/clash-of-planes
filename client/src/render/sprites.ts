// Spritesheet = one image + an atlas of named frames. Each frame has a pivot (px, py,
// default: centre) and `r` — the entity's collision radius in sheet pixels — so a frame
// can be scaled to whatever radius the entity has (asteroids come in many sizes).

import { z } from "zod";

/** The atlas JSON: named frames in the sheet image. It is fetched, so it is checked. */
export const atlasSchema = z.object({
  frames: z.record(
    z.string(),
    z.object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
      r: z.number(),
      px: z.number().optional(),
      py: z.number().optional(),
    }),
  ),
});

export type Atlas = z.infer<typeof atlasSchema>;

export class SpriteSheet {
  readonly image: CanvasImageSource;
  readonly frames: Atlas["frames"];

  constructor(image: CanvasImageSource, atlas: Atlas) {
    this.image = image;
    this.frames = atlas.frames;
  }

  has(name: string): boolean {
    return name in this.frames;
  }

  /** Draws frame `name` centred on (x, y) in the current transform, sized so that its
   * `r` maps onto `radius` world units. (Positional arguments, not an options object: this runs
   * hundreds of times a frame, and an object literal per call is garbage per call.) */
  draw(
    ctx: CanvasRenderingContext2D,
    name: string,
    x: number,
    y: number,
    angle: number,
    radius: number,
    alpha = 1,
  ): void {
    const f = this.frames[name];
    if (!f) return;
    const scale = radius / f.r;
    const px = f.px ?? f.w / 2;
    const py = f.py ?? f.h / 2;
    ctx.save();
    ctx.translate(x, y);
    if (angle) ctx.rotate(angle);
    ctx.scale(scale, scale);
    if (alpha !== 1) ctx.globalAlpha = alpha;
    ctx.drawImage(this.image, f.x, f.y, f.w, f.h, -px, -py, f.w, f.h);
    ctx.restore();
  }
}

/** Both halves are optional assets; without either one the renderer keeps its vector
 * shapes, so a 404 on the sheet or a broken atlas costs looks, not the game. */
export function createSpriteSheet(image: unknown, atlas: unknown): SpriteSheet | null {
  if (!(image instanceof HTMLImageElement)) return null;
  const parsed = atlasSchema.safeParse(atlas);
  return parsed.success ? new SpriteSheet(image, parsed.data) : null;
}
