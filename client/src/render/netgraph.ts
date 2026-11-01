// The netgraph (Lab 5, §7): a small overlay that is the instrument for the whole lab.
//   RTT (with a history line), snapshot age, bytes per second, inputs in flight, and the size
//   of every reconciliation correction. If you are going to look at one thing, look at the
//   correction line: flat at ~0 means the prediction agrees with the server.

import type { GameSession } from "../game/session.ts";
import type { NetReport } from "../game/netstats.ts";
import { beginScreen, type View } from "./canvas.ts";

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

const level = (value: number, warn: number, bad: number): string =>
  value >= bad ? C.bad : value >= warn ? C.warn : C.good;

function spark(
  ctx: CanvasRenderingContext2D,
  values: Float64Array,
  count: number,
  x: number,
  y: number,
  w: number,
  h: number,
  max: number,
  color: string,
): void {
  ctx.strokeStyle = C.dim;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  if (count < 2) return;
  const top = Math.max(max, 1e-6);
  ctx.strokeStyle = color;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const px = x + (i / (count - 1)) * w;
    const py = y + h - Math.min(1, (values[i] ?? 0) / top) * h;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB/s`;

const FONT = '12px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const W = 344;

/** One line of the panel, already formatted. */
interface Row {
  label: string;
  value: string;
  color: string;
}

// ── nothing here allocates per frame ─────────────────────────────────────────────────────
// The text only changes when the stats do — at most every 100 ms (`liveReport`) — so the rows are
// formatted then, once, and the 60 frames in between just draw the same strings. The sparklines
// copy their history into two scratch buffers that live for the whole session.
const rtt = new Float64Array(120);
const corrections = new Float64Array(150);
const rows: Row[] = [];
let formattedFor: NetReport | null = null;
let formattedChaos = Number.NaN;
let rowCount = 0;

function setRow(i: number, label: string, value: string, color: string = C.text): void {
  const row = rows[i];
  if (row) {
    row.label = label;
    row.value = value;
    row.color = color;
  } else rows[i] = { label, value, color };
}

function format(
  r: NetReport,
  o: { predict: boolean; reconcile: boolean; smoothMs: number; interpMs: number; chaos: number },
  codec: string,
): void {
  let i = 0;
  setRow(
    i++,
    "RTT",
    `${r.rttMs.toFixed(0)} ms  (mean ${r.rttMeanMs.toFixed(0)} ±${r.rttJitterMs.toFixed(0)})`,
    level(r.rttMs, 80, 160),
  );
  setRow(
    i++,
    "snapshot age",
    `${Number.isFinite(r.snapshotAgeMs) ? r.snapshotAgeMs.toFixed(0) : "—"} ms  (every ${r.snapshotIntervalMs.toFixed(1)}, max ${r.snapshotIntervalMaxMs.toFixed(0)})`,
    level(r.snapshotAgeMs, 60, 120),
  );
  setRow(i++, "traffic", `↓ ${kb(r.downBytesPerSec)}   ↑ ${kb(r.upBytesPerSec)}`);
  setRow(i++, "snapshot size", `${r.avgSnapshotBytes.toFixed(0)} B  (${codec})`);
  setRow(i++, "pending inputs", `${r.pendingInputs}  (≈ RTT / 33 ms)`);
  setRow(
    i++,
    "correction",
    `${r.correction.toFixed(2)} u   mean ${r.correctionMean.toFixed(2)}   max ${r.correctionMax.toFixed(1)}${r.teleports ? `  (+${r.teleports} респавн)` : ""}`,
    level(r.correction, 0.5, 5),
  );
  setRow(
    i++,
    "loss / starved",
    `${r.lossPercent.toFixed(1)}%  /  ${r.starvedPercent.toFixed(1)}% of frames`,
    level(r.starvedPercent, 1, 5),
  );
  setRow(
    i++,
    "settings",
    `predict ${o.predict ? "on" : "OFF"} · reconcile ${o.reconcile ? "on" : "OFF"}`,
    o.predict && o.reconcile ? C.text : C.warn,
  );
  setRow(i++, "", `smooth ${o.smoothMs} ms · interp ${o.interpMs} ms`);
  if (o.chaos) setRow(i++, "", `ШУМ у integrate: ${(o.chaos * 100).toFixed(1)}%`, C.bad);
  rowCount = i;
}

/** `session`: we read `stats`, `options` and `codec`. */
export function drawNetgraph(
  view: View,
  session: Pick<GameSession, "stats" | "options" | "codec">,
): void {
  const { ctx } = view;
  const r = session.stats.liveReport();
  const o = session.options;
  if (r !== formattedFor || o.chaos !== formattedChaos) {
    format(r, o, session.codec.name);
    formattedFor = r;
    formattedChaos = o.chaos;
  }
  const h = 6 + rowCount * 16 + 56;
  const x = view.width - W - 12;
  const y = view.height - h - 36;

  beginScreen(view);
  ctx.fillStyle = C.bg;
  ctx.fillRect(x, y, W, h);
  ctx.strokeStyle = C.border;
  ctx.strokeRect(x + 0.5, y + 0.5, W, h);
  ctx.font = FONT;
  ctx.textBaseline = "top";

  let rowY = y + 6;
  for (let i = 0; i < rowCount; i++) {
    const row = rows[i];
    if (!row) continue;
    ctx.fillStyle = C.dim;
    ctx.fillText(row.label, x + 8, rowY);
    ctx.fillStyle = row.color;
    ctx.fillText(row.value, x + 112, rowY);
    rowY += 16;
  }

  // history lines: RTT (top) and correction size (bottom)
  const gx = x + 8;
  const gw = W - 16;
  const nRtt = session.stats.rtt.copyRecent(rtt.length, rtt);
  spark(ctx, rtt, nRtt, gx, rowY + 2, gw, 22, Math.max(150, session.stats.rtt.max), C.line);
  const nCorr = session.stats.corrections.copyRecent(corrections.length, corrections);
  spark(ctx, corrections, nCorr, gx, rowY + 28, gw, 22, Math.max(2, r.correctionMax), C.warn);
  ctx.fillStyle = C.dim;
  ctx.fillText("RTT", gx + gw - 24, rowY + 4);
  ctx.fillText("correction", gx + gw - 66, rowY + 30);
}
