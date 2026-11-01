// rss.csv → rss.svg, with no dependencies: two lines over the same time axis.
//   node scripts/plot-rss.js [dir=../docs/lab-04]

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dir = process.argv[2] ?? join(import.meta.dirname, "../../docs/lab-04");
const rows = (await readFile(join(dir, "rss.csv"), "utf8"))
  .trim()
  .split("\n")
  .slice(1)
  .map((l) => l.split(","));
const series = new Map();
for (const [run, phase, t, rss] of rows) {
  if (!series.has(run)) series.set(run, []);
  series.get(run).push({ phase, t: Number(t), rss: Number(rss) });
}
const summary = JSON.parse(await readFile(join(dir, "rss-summary.json"), "utf8"));

const W = 760,
  H = 380,
  L = 64,
  R = 20,
  T = 54,
  B = 50;
const tMax = Math.max(...[...series.values()].flat().map((p) => p.t));
const yMax = Math.ceil((Math.max(...[...series.values()].flat().map((p) => p.rss)) + 20) / 50) * 50;
const x = (t) => L + (t / tMax) * (W - L - R);
const y = (v) => H - B - (v / yMax) * (H - T - B);
const color = { pipeline: "#2a9d5c", naive: "#d9534f" };
const label = { pipeline: "pipeline(createReadStream, res)", naive: "readFile → res.end(buffer)" };

let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="12">
<rect width="${W}" height="${H}" fill="#ffffff"/>
<text x="${L}" y="22" font-size="15" font-weight="600" fill="#1b2a35">Server rss while a ${summary.logMB} MB log is downloaded at ${summary.rateMBps} MB/s</text>
<text x="${L}" y="40" fill="#56707f">same file, same slow client, two implementations (download starts after ~2 s of idle)</text>\n`;
for (let v = 0; v <= yMax; v += 50) {
  svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e3eaee"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" fill="#56707f">${v}</text>\n`;
}
for (let t = 0; t <= tMax; t += 5) {
  svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${H - B}" y2="${H - B + 4}" stroke="#56707f"/><text x="${x(t)}" y="${H - B + 18}" text-anchor="middle" fill="#56707f">${t}</text>\n`;
}
svg += `<text x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle" fill="#56707f">time, s</text>
<text transform="translate(16 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" fill="#56707f">rss, MB</text>
<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#56707f"/><line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" stroke="#56707f"/>\n`;
let ly = T + 12;
for (const [run, pts] of series) {
  svg += `<polyline fill="none" stroke="${color[run]}" stroke-width="2.2" points="${pts.map((p) => `${x(p.t).toFixed(1)},${y(p.rss).toFixed(1)}`).join(" ")}"/>\n`;
  const s = summary[run];
  svg += `<rect x="${L + 14}" y="${ly - 9}" width="12" height="3" fill="${color[run]}"/><text x="${L + 32}" y="${ly}" fill="#1b2a35">${label[run]}: ${s.idleMB} → peak ${s.peakMB} MB (+${s.growthMB})</text>\n`;
  ly += 18;
}
svg += "</svg>\n";
await writeFile(join(dir, "rss.svg"), svg);
console.log(`wrote ${join(dir, "rss.svg")}`);
