// Spritesheet = one image + an atlas of named frames. Each frame has a pivot (px, py,
// default: centre) and `r` — the entity's collision radius in sheet pixels — so a frame
// can be scaled to whatever radius the entity has (asteroids come in many sizes).

export class SpriteSheet {
  constructor(image, atlas) {
    this.image = image;
    this.frames = atlas.frames;
  }

  has(name) {
    return name in this.frames;
  }

  /** Draws frame `name` centred on (x, y) in the current transform, sized so that its
   * `r` maps onto `radius` world units. */
  draw(ctx, name, x, y, { angle = 0, radius, alpha = 1 } = {}) {
    const f = this.frames[name];
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
export function createSpriteSheet(image, atlas) {
  if (!image || !atlas?.frames) return null;
  return new SpriteSheet(image, atlas);
}
