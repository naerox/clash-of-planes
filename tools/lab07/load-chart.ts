// The load graph for the README: server tick time against the number of clients in ONE match,
// before and after the changes, with the 33 ms budget of a 30 Hz tick drawn as a line.
//
//   node tools/lab07/load-chart.ts   (reads docs/lab-07/{before,after}-load*/loadtest.json)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const ROOT = join(import.meta.dirname, "../..");
const point = z.object({
  mode: z.string(),
  n: z.number(),
  tickMeanMs: z.number(),
  tickP99Ms: z.number(),
  skippedTicks: z.number(),
  matches: z.number(),
});
const file = z.object({ points: z.array(point) });
const load = (dir: string) =>
  file.parse(JSON.parse(readFileSync(join(ROOT, "docs/lab-07", dir, "loadtest.json"), "utf8")))
    .points;

const series = (labels: string[]) =>
  labels
    .flatMap(load)
    .filter((p) => p.mode === "room" && p.matches > 0) // a run where no match ever started has no tick to plot
    .sort((a, b) => a.n - b.n);

const before = series(["before-load", "before-load-big"]);
const after = series(["after-load", "after-load-big"]);

const W = 760;
const H = 420;
const m = { l: 56, r: 130, t: 36, b: 52 };
const maxN = Math.max(...before.map((p) => p.n), ...after.map((p) => p.n));
const maxY = 60;
const x = (n: number): number => m.l + (n / maxN) * (W - m.l - m.r);
const y = (ms: number): number => H - m.b - (Math.min(ms, maxY) / maxY) * (H - m.t - m.b);

const COLORS = {
  before: "#c2410c",
  after: "#0e7490",
  limit: "#b91c1c",
  grid: "#d4d4d8",
  text: "#27272a",
};
const path = (ps: typeof before, key: "tickMeanMs" | "tickP99Ms") =>
  ps.map((p, i) => `${i ? "L" : "M"}${x(p.n).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
const dots = (ps: typeof before, key: "tickMeanMs" | "tickP99Ms", color: string) =>
  ps
    .map(
      (p) =>
        `<circle cx="${x(p.n).toFixed(1)}" cy="${y(p[key]).toFixed(1)}" r="3" fill="${color}"/>`,
    )
    .join("");

let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" font-size="12" role="img" aria-label="Server tick time against clients in one match">`;
svg += `<rect width="${W}" height="${H}" fill="#ffffff"/>`;
svg += `<text x="${m.l}" y="22" font-size="14" font-weight="600" fill="${COLORS.text}">Server tick time vs clients in one match (30 Hz → budget 33 ms)</text>`;
for (const ms of [0, 10, 20, 30, 40, 50, 60]) {
  svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(ms)}" y2="${y(ms)}" stroke="${COLORS.grid}"/>`;
  svg += `<text x="${m.l - 8}" y="${y(ms) + 4}" text-anchor="end" fill="${COLORS.text}">${ms}</text>`;
}
for (const n of [...new Set([...before, ...after].map((p) => p.n))]) {
  svg += `<text x="${x(n)}" y="${H - m.b + 18}" text-anchor="middle" fill="${COLORS.text}">${n}</text>`;
}
svg += `<text x="${(m.l + W - m.r) / 2}" y="${H - 8}" text-anchor="middle" fill="${COLORS.text}">clients in one match</text>`;
svg += `<text transform="translate(14 ${H / 2}) rotate(-90)" text-anchor="middle" fill="${COLORS.text}">tick time, ms</text>`;
svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(33.3)}" y2="${y(33.3)}" stroke="${COLORS.limit}" stroke-width="1.5" stroke-dasharray="6 4"/>`;
svg += `<text x="${W - m.r + 6}" y="${y(33.3) + 4}" fill="${COLORS.limit}">33 ms</text>`;
for (const [ps, color, name, dash] of [
  [before, COLORS.before, "before", ""],
  [after, COLORS.after, "after", ""],
] as const) {
  svg += `<path d="${path(ps, "tickP99Ms")}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="${dash || "0"}"/>${dots(ps, "tickP99Ms", color)}`;
  svg += `<path d="${path(ps, "tickMeanMs")}" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="2 4"/>`;
  const last = ps.at(-1);
  if (last)
    svg += `<text x="${x(last.n) + 8}" y="${y(last.tickP99Ms) + 4}" fill="${color}" font-weight="600">${name} p99</text>`;
}
svg += `<text x="${m.l + 8}" y="${m.t + 14}" fill="${COLORS.text}" font-size="11">solid = p99, dotted = mean · one process, one match, clients on the same 4-core VM</text>`;
svg += `</svg>`;
writeFileSync(join(ROOT, "docs/lab-07/load-chart.svg"), svg);
console.log("wrote docs/lab-07/load-chart.svg");
