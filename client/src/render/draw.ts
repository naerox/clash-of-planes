import {
  ARENA,
  BULLET_PARAMS,
  PICKUP_PARAMS,
  SHIP_PARAMS,
  type AsteroidSnap,
  type PickupSnap,
} from "@dogfight/shared";
import type { DrawBullet, DrawShip } from "../game/scene.ts";
import type { FeedEntry } from "../ui/hudFeed.ts";
import type { LoopStats } from "../stats.ts";
import { beginScreen, beginWorld, type View } from "./canvas.ts";
import type { DrawParticle } from "./particles.ts";

const COLORS = {
  letterbox: "#070d13",
  sky: "#0e1b26",
  gridMinor: "#15283a",
  gridMajor: "#22405a",
  border: "#3a6a8c",
  fuselage: "#e9dcc0",
  wing: "#c8553d",
  flame: "#ffb84d",
  bullet: "#ffe28a",
  asteroid: "#8a7a68",
  asteroidEdge: "#5c5042",
  particle: "#ffb84d",
  pickupShield: "#5ec8f2",
  pickupRapid: "#f25ec8",
  hud: "#9fc3d8",
  hudWarn: "#ff7a59",
  hpFull: "#5ec88a",
  hpLow: "#ff7a59",
};

const GRID = 100;

// Constants the draw functions would otherwise rebuild on every call (an array literal, a template
// string): hoisted, so a frame allocates none of them.
const WRAP_X = [-ARENA.width, 0, ARENA.width];
const WRAP_Y = [-ARENA.height, 0, ARENA.height];
const ASTEROID_FRAMES = ["asteroid_0", "asteroid_1", "asteroid_2"];

let nameFontScale = Number.NaN;
let nameFontString = "";
/** The pilot-name font for this canvas scale — rebuilt only when the window is resized. */
function nameFont(scale: number): string {
  if (scale !== nameFontScale) {
    nameFontScale = scale;
    nameFontString = `${Math.round(13 / scale)}px ui-monospace, Menlo, Consolas, monospace`;
  }
  return nameFontString;
}

export function drawBackground(view: View): void {
  const { ctx } = view;

  beginScreen(view);
  ctx.fillStyle = COLORS.letterbox;
  ctx.fillRect(0, 0, view.width, view.height);

  beginWorld(view);
  ctx.fillStyle = COLORS.sky;
  ctx.fillRect(0, 0, ARENA.width, ARENA.height);

  ctx.lineWidth = 1 / view.scale;
  for (let x = 0; x <= ARENA.width; x += GRID) {
    ctx.strokeStyle = x % (GRID * 4) === 0 ? COLORS.gridMajor : COLORS.gridMinor;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ARENA.height);
    ctx.stroke();
  }
  for (let y = 0; y <= ARENA.height; y += GRID) {
    ctx.strokeStyle = y % (GRID * 4) === 0 ? COLORS.gridMajor : COLORS.gridMinor;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(ARENA.width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 2 / view.scale;
  ctx.strokeRect(0, 0, ARENA.width, ARENA.height);
}

function drawBiplane(ctx: CanvasRenderingContext2D, thrusting: boolean, flicker: number): void {
  if (thrusting) {
    ctx.fillStyle = COLORS.flame;
    ctx.beginPath();
    ctx.moveTo(-22, -4);
    ctx.lineTo(-22 - 22 * flicker, 0);
    ctx.lineTo(-22, 4);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = COLORS.wing;
  ctx.fillRect(-4, -24, 13, 48);
  ctx.fillRect(-24, -10, 6, 20);
  ctx.fillStyle = COLORS.fuselage;
  ctx.beginPath();
  ctx.moveTo(26, 0);
  ctx.lineTo(8, -6);
  ctx.lineTo(-22, -3);
  ctx.lineTo(-22, 3);
  ctx.lineTo(8, 6);
  ctx.closePath();
  ctx.fill();
}

// Lab 5: everything below draws a SCENE — plain lists of `{ x, y, angle, … }` that the network
// layer (game/session.ts) has already placed: our own ship from prediction, everything else from
// interpolation between snapshots. Nothing here knows where positions come from.

/** Ship: drawn with the Lab 1 wrap-ghost trick (draw at up to 9 offsets, clipped to the
 * arena) so crossing an edge looks continuous. Nothing else wraps, so nothing else needs this. */
export function drawShip(view: View, ship: DrawShip): void {
  if (ship.dead) return;
  const { ctx } = view;
  const flicker = 0.75 + 0.25 * Math.sin(performance.now() / 40);

  beginWorld(view);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, ARENA.width, ARENA.height);
  ctx.clip();

  for (const dx of WRAP_X) {
    for (const dy of WRAP_Y) {
      const x = ship.x + dx;
      const y = ship.y + dy;
      if (x < -30 || x > ARENA.width + 30 || y < -30 || y > ARENA.height + 30) continue;
      if (view.sprites) {
        const frame = ship.thrusting
          ? flicker > 0.75
            ? "ship_thrust_0"
            : "ship_thrust_1"
          : "ship";
        view.sprites.draw(ctx, frame, x, y, ship.angle, SHIP_PARAMS.radius);
      } else {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(ship.angle);
        drawBiplane(ctx, ship.thrusting, flicker);
        ctx.restore();
      }
    }
  }
  ctx.restore();

  // the pilot's name, above the ship (upright, whatever the heading)
  ctx.font = nameFont(view.scale);
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = ship.isMe ? COLORS.hpFull : COLORS.hud;
  ctx.fillText(ship.name, ship.x, ship.y - SHIP_PARAMS.radius - 6);
  ctx.textAlign = "left";
}

export function drawBullets(view: View, bullets: readonly DrawBullet[]): void {
  const { ctx } = view;
  beginWorld(view);
  ctx.fillStyle = COLORS.bullet;
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    if (!b) continue;
    if (view.sprites) {
      view.sprites.draw(ctx, "bullet", b.x, b.y, 0, BULLET_PARAMS.radius);
      continue;
    }
    ctx.beginPath();
    ctx.arc(b.x, b.y, BULLET_PARAMS.radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawAsteroids(view: View, asteroids: readonly AsteroidSnap[]): void {
  const { ctx } = view;
  beginWorld(view);
  for (let i = 0; i < asteroids.length; i++) {
    const a = asteroids[i];
    if (!a) continue;
    if (view.sprites) {
      const frame = a.hunter ? "asteroid_hunter" : (ASTEROID_FRAMES[a.id % 3] ?? "asteroid_0");
      view.sprites.draw(ctx, frame, a.x, a.y, a.angle, a.radius);
      continue;
    }
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.rotate(a.angle);
    ctx.fillStyle = a.hunter ? "#b05c5c" : COLORS.asteroid; // tinted red when it hunts
    ctx.strokeStyle = COLORS.asteroidEdge;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const spikes = 8;
    for (let i = 0; i < spikes; i++) {
      const a0 = (i / spikes) * Math.PI * 2;
      const r = a.radius * (0.82 + 0.18 * Math.sin(i * 7.3 + a.id));
      const x = Math.cos(a0) * r;
      const y = Math.sin(a0) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

export function drawParticles(view: View, particles: readonly DrawParticle[]): void {
  const { ctx } = view;
  beginWorld(view);
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (!p) continue;
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = COLORS.particle;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export function drawPickups(view: View, pickups: readonly PickupSnap[]): void {
  const { ctx } = view;
  beginWorld(view);
  const pulse = 1 + 0.15 * Math.sin(performance.now() / 200);
  for (let i = 0; i < pickups.length; i++) {
    const pk = pickups[i];
    if (!pk) continue;
    if (view.sprites) {
      view.sprites.draw(
        ctx,
        pk.variant === "shield" ? "pickup_shield" : "pickup_rapid",
        pk.x,
        pk.y,
        0,
        PICKUP_PARAMS.radius * pulse,
      );
      continue;
    }
    ctx.fillStyle = pk.variant === "shield" ? COLORS.pickupShield : COLORS.pickupRapid;
    ctx.save();
    ctx.translate(pk.x, pk.y);
    ctx.rotate(Math.PI / 4);
    const r = PICKUP_PARAMS.radius * pulse;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }
}

const hudRows: string[] = [];
let hudStamp = -Infinity;

export function drawHud(view: View, stats: LoopStats, lines: readonly string[] = []): void {
  const { ctx } = view;
  beginScreen(view);
  ctx.font = '13px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  ctx.textBaseline = "top";

  // the numbers change a few times a second at most: format them at 4 Hz, not at 60
  const now = performance.now();
  if (now - hudStamp >= 250) {
    hudStamp = now;
    hudRows.length = 0;
    hudRows.push(
      `steps/s   ${stats.stepsPerSec.toFixed(0)}`,
      `frames/s  ${stats.framesPerSec.toFixed(0)}`,
      `frame     ${stats.frameMs.toFixed(2)} ms`,
      ...lines,
    );
  }

  ctx.fillStyle = COLORS.hud;
  for (let i = 0; i < hudRows.length; i++) ctx.fillText(hudRows[i] ?? "", 12, 10 + i * 17);

  ctx.fillStyle = COLORS.hud;
  ctx.textBaseline = "bottom";
  ctx.fillText(
    "←/→ або A/D — поворот   ↑ або W — тяга   Space — вогонь   Enter — чат   M — звук   F2 — мережа   F3 — netgraph",
    12,
    view.height - 10,
  );
}

/** Lab 3: the bus-driven event feed (hudFeed.ts), fading out under the ship status. */
export function drawEventFeed(view: View, entries: readonly FeedEntry[]): void {
  const { ctx } = view;
  beginScreen(view);
  ctx.font = '13px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  ctx.textBaseline = "top";
  ctx.textAlign = "right";
  entries.forEach((entry, i) => {
    ctx.globalAlpha = entry.alpha;
    ctx.fillStyle = entry.text.startsWith("exploded") ? COLORS.hudWarn : COLORS.hud;
    ctx.fillText(entry.text, view.width - 16, 70 + i * 17);
  });
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
}

/** Ship HP bar + score of the LOCAL player. `me` comes from the scene: { hp, score, dead, respawn, rapid }. */
let scoreShown = Number.NaN;
let scoreText = "";

export function drawShipStatus(view: View, me: DrawShip | null): void {
  if (!me) return;
  const { ctx } = view;
  beginScreen(view);
  const barW = 160;
  const barH = 10;
  const x = view.width - barW - 16;
  const y = 14;

  ctx.textBaseline = "top";
  ctx.font = '13px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  ctx.fillStyle = COLORS.hud;
  ctx.textAlign = "right";
  if (me.score !== scoreShown) {
    scoreShown = me.score;
    scoreText = `score ${me.score}`;
  }
  ctx.fillText(scoreText, x + barW, y - 2);
  ctx.textAlign = "left";

  ctx.fillStyle = "#1a2c3a";
  ctx.fillRect(x, y + 16, barW, barH);
  const pct = Math.max(0, me.hp / SHIP_PARAMS.maxHp);
  ctx.fillStyle = pct > 0.3 ? COLORS.hpFull : COLORS.hpLow;
  ctx.fillRect(x, y + 16, barW * pct, barH);
  ctx.strokeStyle = COLORS.hud;
  ctx.strokeRect(x, y + 16, barW, barH);

  if (me.dead) {
    ctx.fillStyle = COLORS.hudWarn;
    ctx.fillText(`respawning ${(me.respawn ?? 0).toFixed(1)}s`, x, y + 32);
  } else if (me.rapid) {
    ctx.fillStyle = COLORS.pickupRapid;
    ctx.fillText("rapid fire", x, y + 32);
  }
}
