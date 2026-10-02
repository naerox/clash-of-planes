import { ARENA } from "../sim/arena.js";

export function setupCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const view = { ctx, width: 0, height: 0, dpr: 1, scale: 1, offsetX: 0, offsetY: 0 };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const scale = Math.min(width / ARENA.width, height / ARENA.height);
    Object.assign(view, {
      width,
      height,
      dpr,
      scale,
      offsetX: (width - ARENA.width * scale) / 2,
      offsetY: (height - ARENA.height * scale) / 2,
    });
  }

  new ResizeObserver(resize).observe(canvas);
  window.addEventListener("resize", resize);
  resize();
  return view;
}

export function beginWorld(view) {
  const { ctx, dpr, scale, offsetX, offsetY } = view;
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offsetX, dpr * offsetY);
}

export function beginScreen(view) {
  const { ctx, dpr } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
