import { ARENA } from "../sim/arena.js";
import { beginScreen, beginWorld } from "./canvas.js";
import { interpolatedPose } from "./interpolate.js";

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
const FRAME_BUDGET_MS = 1000 / 60;

export function drawBackground(view) {
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

function drawBiplane(ctx, thrusting, flicker) {
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

/** Ship: drawn with the Lab 1 wrap-ghost trick (draw at up to 9 offsets, clipped to the
 * arena) so crossing an edge looks continuous. Nothing else wraps, so nothing else needs this. */
export function drawShip(view, ship, alpha) {
  if (ship.isDead) return;
  const { ctx } = view;
  const { pos, angle } = interpolatedPose(ship, alpha);
  const flicker = 0.75 + 0.25 * Math.sin(performance.now() / 40);

  beginWorld(view);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, ARENA.width, ARENA.height);
  ctx.clip();

  for (const dx of [-ARENA.width, 0, ARENA.width]) {
    for (const dy of [-ARENA.height, 0, ARENA.height]) {
      const x = pos.x + dx;
      const y = pos.y + dy;
      if (x < -30 || x > ARENA.width + 30 || y < -30 || y > ARENA.height + 30) continue;
      if (view.sprites) {
        const frame = ship.thrusting ? `ship_thrust_${flicker > 0.75 ? 0 : 1}` : "ship";
        view.sprites.draw(ctx, frame, x, y, { angle, radius: ship.radius });
        continue;
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      drawBiplane(ctx, ship.thrusting, flicker);
      ctx.restore();
    }
  }
  ctx.restore();
}

export function drawBullets(view, world, alpha) {
  const { ctx } = view;
  beginWorld(view);
  ctx.fillStyle = COLORS.bullet;
  for (const b of world.ofKind("bullet")) {
    const { pos } = interpolatedPose(b, alpha);
    if (view.sprites) {
      view.sprites.draw(ctx, "bullet", pos.x, pos.y, { radius: b.radius });
      continue;
    }
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, b.radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawAsteroids(view, world, alpha) {
  const { ctx } = view;
  beginWorld(view);
  for (const a of world.ofKind("asteroid")) {
    const { pos, angle } = interpolatedPose(a, alpha);
    if (view.sprites) {
      const frame = a.homing ? "asteroid_hunter" : `asteroid_${a.id % 3}`;
      view.sprites.draw(ctx, frame, pos.x, pos.y, { angle, radius: a.radius });
      continue;
    }
    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(angle);
    ctx.fillStyle = a.homing ? "#b05c5c" : COLORS.asteroid; // tinted red when homing (M4)
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

export function drawParticles(view, world, alpha) {
  const { ctx } = view;
  beginWorld(view);
  for (const p of world.ofKind("particle")) {
    const { pos } = interpolatedPose(p, alpha);
    ctx.globalAlpha = Math.max(0, p.ttl / p.maxTtl);
    ctx.fillStyle = COLORS.particle;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, p.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export function drawPickups(view, world, alpha) {
  const { ctx } = view;
  beginWorld(view);
  const pulse = 1 + 0.15 * Math.sin(performance.now() / 200);
  for (const pk of world.ofKind("pickup")) {
    const { pos } = interpolatedPose(pk, alpha);
    if (view.sprites) {
      view.sprites.draw(ctx, `pickup_${pk.type}`, pos.x, pos.y, { radius: pk.radius * pulse });
      continue;
    }
    ctx.fillStyle = pk.type === "shield" ? COLORS.pickupShield : COLORS.pickupRapid;
    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(Math.PI / 4);
    const r = pk.radius * pulse;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }
}

export function drawHud(view, stats, lines = []) {
  const { ctx } = view;
  beginScreen(view);
  ctx.font = '13px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  ctx.textBaseline = "top";

  const rows = [
    `steps/s   ${stats.stepsPerSec.toFixed(0)}`,
    `frames/s  ${stats.framesPerSec.toFixed(0)}`,
    `frame     ${stats.frameMs.toFixed(2)} ms`,
    ...lines,
  ];

  rows.forEach((text, i) => {
    ctx.fillStyle =
      text.startsWith("delta") && stats.deltaMs > FRAME_BUDGET_MS * 1.5
        ? COLORS.hudWarn
        : COLORS.hud;
    ctx.fillText(text, 12, 10 + i * 17);
  });

  ctx.fillStyle = COLORS.hud;
  ctx.textBaseline = "bottom";
  ctx.fillText(
    "←/→ або A/D — поворот   ↑ або W — тяга   Space — вогонь   R — скинути   M — звук",
    12,
    view.height - 10,
  );
}

/** Lab 3: the bus-driven event feed (hudFeed.js), fading out under the ship status. */
export function drawEventFeed(view, entries) {
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

/** Ship HP bar + score, drawn separately from the perf HUD so M3's "score on the HUD"
 * requirement has one obvious, easy-to-point-at place during the defense. */
export function drawShipStatus(view, ship) {
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
  ctx.fillText(`score ${ship.score}`, x + barW, y - 2);
  ctx.textAlign = "left";

  ctx.fillStyle = "#1a2c3a";
  ctx.fillRect(x, y + 16, barW, barH);
  const pct = ship.hp / ship.params.maxHp;
  ctx.fillStyle = pct > 0.3 ? COLORS.hpFull : COLORS.hpLow;
  ctx.fillRect(x, y + 16, barW * pct, barH);
  ctx.strokeStyle = COLORS.hud;
  ctx.strokeRect(x, y + 16, barW, barH);

  if (ship.isDead) {
    ctx.fillStyle = COLORS.hudWarn;
    ctx.fillText("respawning…", x, y + 32);
  } else if (ship.rapidTimer > 0) {
    ctx.fillStyle = COLORS.pickupRapid;
    ctx.fillText(`rapid ${ship.rapidTimer.toFixed(1)}s`, x, y + 32);
  }
}
