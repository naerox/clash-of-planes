// The netgraph (Lab 5, §7): a small overlay that is the instrument for the whole lab.
//   RTT (with a history line), snapshot age, bytes per second, inputs in flight, and the size
//   of every reconciliation correction. If you are going to look at one thing, look at the
//   correction line: flat at ~0 means the prediction agrees with the server.

import { beginScreen } from "./canvas.js";

const C = {
  bg: "#070d13d9",
  border: "#3a6a8c",
  text: "#9fc3d8",
  dim: "#56707f",
  good: "#5ec88a",
  warn: "#ffb84d",
  bad: "#ff7a59",
  line: "#5ec8f2",
};

const level = (value, warn, bad) => (value >= bad ? C.bad : value >= warn ? C.warn : C.good);

function spark(ctx, values, x, y, w, h, { max, color }) {
  ctx.strokeStyle = C.dim;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  if (values.length < 2) return;
  const top = Math.max(max, 1e-6);
  ctx.strokeStyle = color;
  ctx.beginPath();
  values.forEach((v, i) => {
    const px = x + (i / (values.length - 1)) * w;
    const py = y + h - Math.min(1, v / top) * h;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB/s`;

/**
 * @param {object} view     the canvas view
 * @param {object} session  GameSession (we read `stats`, `options`, `codec`)
 */
export function drawNetgraph(view, session) {
  const { ctx } = view;
  const r = session.stats.report();
  const o = session.options;
  const w = 344;
  const rows = 9 + (o.chaos ? 1 : 0);
  const h = 6 + rows * 16 + 56;
  const x = view.width - w - 12;
  const y = view.height - h - 36;

  beginScreen(view);
  ctx.fillStyle = C.bg;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = C.border;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.font = '12px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  ctx.textBaseline = "top";

  let row = y + 6;
  const line = (label, value, color = C.text) => {
    ctx.fillStyle = C.dim;
    ctx.fillText(label, x + 8, row);
    ctx.fillStyle = color;
    ctx.fillText(value, x + 112, row);
    row += 16;
  };

  line(
    "RTT",
    `${r.rttMs.toFixed(0)} ms  (mean ${r.rttMeanMs.toFixed(0)} ±${r.rttJitterMs.toFixed(0)})`,
    level(r.rttMs, 80, 160),
  );
  line(
    "snapshot age",
    `${Number.isFinite(r.snapshotAgeMs) ? r.snapshotAgeMs.toFixed(0) : "—"} ms  (every ${r.snapshotIntervalMs.toFixed(1)}, max ${r.snapshotIntervalMaxMs.toFixed(0)})`,
    level(r.snapshotAgeMs, 60, 120),
  );
  line("traffic", `↓ ${kb(r.downBytesPerSec)}   ↑ ${kb(r.upBytesPerSec)}`);
  line("snapshot size", `${r.avgSnapshotBytes.toFixed(0)} B  (${session.codec.name})`);
  line("pending inputs", `${r.pendingInputs}  (≈ RTT / 33 ms)`, C.text);
  line(
    "correction",
    `${r.correction.toFixed(2)} u   mean ${r.correctionMean.toFixed(2)}   max ${r.correctionMax.toFixed(1)}${r.teleports ? `  (+${r.teleports} респавн)` : ""}`,
    level(r.correction, 0.5, 5),
  );
  line(
    "loss / starved",
    `${r.lossPercent.toFixed(1)}%  /  ${r.starvedPercent.toFixed(1)}% of frames`,
    level(r.starvedPercent, 1, 5),
  );
  line(
    "settings",
    `predict ${o.predict ? "on" : "OFF"} · reconcile ${o.reconcile ? "on" : "OFF"}`,
    o.predict && o.reconcile ? C.text : C.warn,
  );
  line("", `smooth ${o.smoothMs} ms · interp ${o.interpMs} ms`);
  if (o.chaos) line("", `ШУМ у integrate: ${(o.chaos * 100).toFixed(1)}%`, C.bad);

  // history lines: RTT (top) and correction size (bottom)
  const gx = x + 8;
  const gw = w - 16;
  spark(ctx, session.stats.rtt.values, gx, row + 2, gw, 22, {
    max: Math.max(150, session.stats.rtt.max),
    color: C.line,
  });
  spark(ctx, session.stats.corrections.recent(150), gx, row + 28, gw, 22, {
    max: Math.max(2, r.correctionMax),
    color: C.warn,
  });
  ctx.fillStyle = C.dim;
  ctx.fillText("RTT", gx + gw - 24, row + 4);
  ctx.fillText("correction", gx + gw - 66, row + 30);
}
