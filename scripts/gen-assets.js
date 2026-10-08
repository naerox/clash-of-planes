// Generates the Lab 3 assets (spritesheet PNG + atlas, sound effects as WAV, manifest)
// procedurally, so the repo has no binary blobs of unknown origin and `npm run assets`
// rebuilds them byte-for-byte (seeded RNG). Run: `node scripts/gen-assets.js`.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "assets");

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- tiny rasterizer

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Float32Array(w * h * 4); // premultiplied RGBA, 0..1
  }

  /** Paints `color` wherever `inside(x, y)` holds, with 4×4 supersampled coverage. */
  fill(bounds, inside, [r, g, b, a = 1]) {
    const x0 = Math.max(0, Math.floor(bounds[0]));
    const y0 = Math.max(0, Math.floor(bounds[1]));
    const x1 = Math.min(this.w - 1, Math.ceil(bounds[2]));
    const y1 = Math.min(this.h - 1, Math.ceil(bounds[3]));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let hits = 0;
        for (let sy = 0; sy < 4; sy++) {
          for (let sx = 0; sx < 4; sx++) {
            if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits++;
          }
        }
        if (hits === 0) continue;
        const k = (hits / 16) * a;
        const i = (y * this.w + x) * 4;
        const p = this.px;
        p[i] = (r / 255) * k + p[i] * (1 - k);
        p[i + 1] = (g / 255) * k + p[i + 1] * (1 - k);
        p[i + 2] = (b / 255) * k + p[i + 2] * (1 - k);
        p[i + 3] = k + p[i + 3] * (1 - k);
      }
    }
  }

  poly(pts, color) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    this.fill(bounds, (x, y) => pointInPoly(pts, x, y), color);
  }

  circle(cx, cy, r, color) {
    this.fill(
      [cx - r, cy - r, cx + r, cy + r],
      (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r,
      color,
    );
  }

  rect(x, y, w, h, color) {
    this.poly(
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      color,
    );
  }

  /** Radial glow: alpha falls off with distance, so bullets read as light, not discs. */
  glow(cx, cy, r, [cr, cg, cb]) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (d >= 1) continue;
        const k = (1 - d) ** 2;
        const i = (y * this.w + x) * 4;
        const p = this.px;
        p[i] = (cr / 255) * k + p[i] * (1 - k);
        p[i + 1] = (cg / 255) * k + p[i + 1] * (1 - k);
        p[i + 2] = (cb / 255) * k + p[i + 2] * (1 - k);
        p[i + 3] = k + p[i + 3] * (1 - k);
      }
    }
  }

  toPng() {
    const raw = Buffer.alloc((this.w * 4 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 4 + 1)] = 0; // filter: none
      for (let x = 0; x < this.w; x++) {
        const i = (y * this.w + x) * 4;
        const a = this.px[i + 3];
        const o = y * (this.w * 4 + 1) + 1 + x * 4;
        const un = a > 0 ? 1 / a : 0; // un-premultiply for PNG
        raw[o] = Math.round(Math.min(1, this.px[i] * un) * 255);
        raw[o + 1] = Math.round(Math.min(1, this.px[i + 1] * un) * 255);
        raw[o + 2] = Math.round(Math.min(1, this.px[i + 2] * un) * 255);
        raw[o + 3] = Math.round(a * 255);
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

function pointInPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// ---------------------------------------------------------------- spritesheet

const PX_PER_UNIT = 2; // sprites are drawn at 2× world resolution, so they stay crisp on HiDPI

const COLORS = {
  fuselage: [233, 220, 192],
  fuselageShade: [196, 180, 150],
  wing: [200, 85, 61],
  wingShade: [150, 58, 42],
  strut: [70, 52, 40],
  cockpit: [40, 60, 80],
  roundelOuter: [40, 90, 170],
  roundelInner: [240, 240, 240],
  roundelCore: [200, 40, 40],
  prop: [60, 50, 40, 0.55],
  flame: [255, 184, 77],
  flameCore: [255, 240, 190],
  bullet: [255, 226, 138],
  rock: [138, 122, 104],
  rockEdge: [92, 80, 66],
  rockCrater: [110, 96, 80],
  hunter: [176, 92, 92],
  hunterEdge: [120, 52, 52],
  shield: [94, 200, 242],
  rapid: [242, 94, 200],
};

/** Paints the biplane into a 160×128 frame, nose toward +x, pivot at (92, 64) so the
 * exhaust flame (up to 42 units behind the pivot) still fits. `flame` ∈ {null, 0, 1}. */
function drawPlane(c, ox, oy, flame) {
  const s = PX_PER_UNIT;
  const cx = ox + 92;
  const cy = oy + 64;
  const P = (x, y) => [cx + x * s, cy + y * s];

  if (flame !== null) {
    const len = flame === 0 ? 20 : 14;
    c.poly([P(-22, -5), P(-22 - len, 0), P(-22, 5)], COLORS.flame);
    c.poly([P(-22, -2.5), P(-22 - len * 0.55, 0), P(-22, 2.5)], COLORS.flameCore);
  }
  // tailplane
  c.poly([P(-25, -11), P(-18, -11), P(-16, 11), P(-25, 11)], COLORS.wingShade);
  // lower wing (shadow) and upper wing
  c.poly([P(-3, -25), P(9, -25), P(9, 25), P(-3, 25)], COLORS.wingShade);
  c.poly([P(-5, -24), P(8, -24), P(8, 24), P(-5, 24)], COLORS.wing);
  // roundels near the wing tips
  for (const wy of [-16, 16]) {
    const [rx, ry] = P(1.5, wy);
    c.circle(rx, ry, 5 * s, COLORS.roundelOuter);
    c.circle(rx, ry, 3.2 * s, COLORS.roundelInner);
    c.circle(rx, ry, 1.6 * s, COLORS.roundelCore);
  }
  // fuselage
  c.poly([P(26, 0), P(8, -6.5), P(-23, -3), P(-23, 3), P(8, 6.5)], COLORS.fuselage);
  c.poly([P(26, 0), P(8, 1), P(-23, 1), P(-23, 3), P(8, 6.5)], COLORS.fuselageShade);
  // cockpit and struts
  const [kx, ky] = P(-6, 0);
  c.circle(kx, ky, 3.2 * s, COLORS.cockpit);
  for (const wy of [-20, 20]) c.rect(...P(-1, wy - 0.8), 8 * s, 1.6 * s, COLORS.strut);
  // spinning propeller disc
  c.poly([P(27, -9), P(29, -9), P(29, 9), P(27, 9)], COLORS.prop);
}

function drawRock(c, ox, oy, size, seed, fill, edge) {
  const rand = rng(seed);
  const cx = ox + size / 2;
  const cy = oy + size / 2;
  const R = size / 2 - 4;
  const n = 11;
  const outline = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const r = R * (0.84 + 0.16 * rand());
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
  c.poly(outline, edge);
  const inner = outline.map(([x, y]) => [cx + (x - cx) * 0.9, cy + (y - cy) * 0.9]);
  c.poly(inner, fill);
  for (let k = 0; k < 4; k++) {
    const a = rand() * Math.PI * 2;
    const d = rand() * R * 0.5;
    const r = R * (0.08 + rand() * 0.12);
    c.circle(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r, COLORS.rockCrater);
  }
  return R * 0.92; // collision radius in px — the drawn rock fills the entity's circle
}

function drawPickup(c, ox, oy, color) {
  const cx = ox + 32;
  const cy = oy + 32;
  const r = 26;
  c.glow(cx, cy, 30, color);
  c.poly(
    [
      [cx, cy - r],
      [cx + r, cy],
      [cx, cy + r],
      [cx - r, cy],
    ],
    color,
  );
  c.poly(
    [
      [cx, cy - r * 0.5],
      [cx + r * 0.5, cy],
      [cx, cy + r * 0.5],
      [cx - r * 0.5, cy],
    ],
    [255, 255, 255, 0.6],
  );
}

function buildSheet() {
  const sheet = new Canvas(768, 320);
  const frames = {};

  const planes = [
    ["ship", null],
    ["ship_thrust_0", 0],
    ["ship_thrust_1", 1],
  ];
  planes.forEach(([name, flame], i) => {
    drawPlane(sheet, i * 160, 0, flame);
    frames[name] = { x: i * 160, y: 0, w: 160, h: 128, px: 92, py: 64, r: 18 * PX_PER_UNIT };
  });

  sheet.glow(480 + 16, 16, 15, COLORS.bullet);
  sheet.circle(480 + 16, 16, 6, [255, 250, 225]);
  frames.bullet = { x: 480, y: 0, w: 32, h: 32, r: 4 * PX_PER_UNIT };

  drawPickup(sheet, 576, 0, COLORS.shield);
  frames.pickup_shield = { x: 576, y: 0, w: 64, h: 64, r: 14 * PX_PER_UNIT };
  drawPickup(sheet, 640, 0, COLORS.rapid);
  frames.pickup_rapid = { x: 640, y: 0, w: 64, h: 64, r: 14 * PX_PER_UNIT };

  for (let i = 0; i < 3; i++) {
    const r = drawRock(sheet, i * 192, 128, 192, 101 + i, COLORS.rock, COLORS.rockEdge);
    frames[`asteroid_${i}`] = { x: i * 192, y: 128, w: 192, h: 192, r };
  }
  const r = drawRock(sheet, 576, 128, 192, 777, COLORS.hunter, COLORS.hunterEdge);
  frames.asteroid_hunter = { x: 576, y: 128, w: 192, h: 192, r };

  return {
    png: sheet.toPng(),
    atlas: {
      meta: { image: "sheet.png", size: [sheet.w, sheet.h], pxPerUnit: PX_PER_UNIT },
      frames,
    },
  };
}

// ---------------------------------------------------------------- sound effects

const RATE = 44100;

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) =>
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2),
  );
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function synth(seconds, fn) {
  return Array.from({ length: Math.floor(seconds * RATE) }, (_, i) => fn(i / RATE, seconds));
}

function fireSfx() {
  let phase = 0;
  return synth(0.14, (t, T) => {
    const f = 1100 * Math.pow(220 / 1100, t / T); // exponential pitch drop: the "pew"
    phase += f / RATE;
    const square = phase % 1 < 0.5 ? 1 : -1;
    return square * 0.35 * Math.exp(-t * 22);
  });
}

function hitSfx() {
  const rand = rng(7);
  let lp = 0;
  return synth(0.12, (t) => {
    lp += 0.35 * (rand() * 2 - 1 - lp);
    const thump = Math.sin(2 * Math.PI * 160 * t) * Math.exp(-t * 30);
    return (lp * 0.8 + thump * 0.7) * Math.exp(-t * 18);
  });
}

function explodeSfx() {
  const rand = rng(42);
  let lp = 0;
  return synth(0.9, (t, T) => {
    const cutoff = 0.25 * (1 - t / T) + 0.02; // the low-pass closes as the blast fades
    lp += cutoff * (rand() * 2 - 1 - lp);
    const rumble = Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 6);
    return (lp * 2.2 + rumble * 0.5) * Math.exp(-t * 4.5);
  });
}

// ---------------------------------------------------------------- write everything

function write(rel, data) {
  const file = join(OUT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  return statSync(file).size;
}

const json = (v) => JSON.stringify(v, null, 2) + "\n";

const { png, atlas } = buildSheet();
const sizes = {
  "sprites/sheet.png": write("sprites/sheet.png", png),
  "sprites/sheet.json": write("sprites/sheet.json", json(atlas)),
  "sfx/fire.wav": write("sfx/fire.wav", wav(fireSfx())),
  "sfx/hit.wav": write("sfx/hit.wav", wav(hitSfx())),
  "sfx/explode.wav": write("sfx/explode.wav", wav(explodeSfx())),
};

const gameConfig = {
  lobby: { url: "/api/rooms", pollMs: 3000, timeoutMs: 2500 },
  audio: { volume: 0.45 },
  defaultArena: { asteroids: 4, hunters: 1, asteroidSpeed: [40, 100] },
};
sizes["config/game.json"] = write("config/game.json", json(gameConfig));
// Deliberately truncated copy, used by the `?fail=json` scenario in the failure gallery.
write("config/game.broken.json", json(gameConfig).slice(0, 60));

const manifest = {
  version: 1,
  assets: [
    { id: "config", type: "json", url: "config/game.json" },
    { id: "sheet", type: "image", url: "sprites/sheet.png", optional: true },
    { id: "atlas", type: "json", url: "sprites/sheet.json", optional: true },
    { id: "sfx.fire", type: "audio", url: "sfx/fire.wav", optional: true },
    { id: "sfx.hit", type: "audio", url: "sfx/hit.wav", optional: true },
    { id: "sfx.explode", type: "audio", url: "sfx/explode.wav", optional: true },
  ].map((a) => ({ ...a, size: sizes[a.url] })),
};
write("manifest.json", json(manifest));

console.log(manifest.assets.map((a) => `${a.url.padEnd(20)} ${a.size} B`).join("\n"));
