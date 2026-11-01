// Numbers for the README's netcode write-up, produced by the in-process lab (test/harness.ts):
// the real Match + the real client GameSession on a virtual network and a virtual clock, so
// every row is repeatable.
//
//   node scripts/netcode-report.ts [--json=../docs/lab-05/netcode-report.json]

import { writeFileSync } from "node:fs";
import { ARENA, wrappedDelta } from "@dogfight/shared";
import {
  createSimulation,
  cruise,
  idle,
  summarize,
  weave,
  type SimulationConfig,
} from "../test/harness.ts";

const jsonOut = process.argv.find((a) => a.startsWith("--json="))?.slice(7);
/** Every table below is also kept here, for `--json=`. */
const report: Record<string, unknown> = {};
const fmt = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : "—");
const table = (title: string, head: string[], rows: string[][]): void => {
  console.log(`\n### ${title}\n`);
  console.log(`| ${head.join(" | ")} |`);
  console.log(`| ${head.map(() => "---").join(" | ")} |`);
  for (const r of rows) console.log(`| ${r.join(" | ")} |`);
};

// ── 1. how long until the ship answers a key press ─────────────────────────────────────
function responseMs(rttMs: number, predict: boolean): number {
  const sim = createSimulation({ rttMs, options: { predict } });
  const press = 2000;
  sim.run(press, idle);
  const start = sim.client(0).renders.at(-1)?.scene.me;
  if (!start) throw new Error("the client drew nothing");
  const moved: { at: number | null } = { at: null };
  sim.run(1000, (_i, t) => (t >= press ? cruise() : idle()), {
    onMs: (t) => {
      const me = sim.client(0).renders.at(-1)?.scene.me;
      if (moved.at === null && t > press && me && Math.hypot(me.x - start.x, me.y - start.y) > 0.5)
        moved.at = t;
    },
  });
  return (moved.at ?? Infinity) - press;
}
{
  const rows = [0, 50, 100, 200].map((rtt) => {
    const dumb = responseMs(rtt, false);
    const predicted = responseMs(rtt, true);
    return { rtt, dumb, predicted };
  });
  report.response = rows;
  table(
    "Time from key press to the ship visibly moving (≥ 0.5 world units)",
    ["RTT", "no prediction (M1)", "prediction (M2)"],
    rows.map((r) => [`${r.rtt} мс`, `${r.dumb} мс`, `${r.predicted} мс`]),
  );
}

// ── 2. corrections, and the determinism break ──────────────────────────────────────────
function corrections(opts: SimulationConfig, seconds = 10) {
  const sim = createSimulation(opts);
  sim.run(seconds * 1000, weave);
  return summarize(sim.client(0).session.stats.corrections.values.slice(30));
}
{
  const rows = [0, 0.002, 0.01, 0.05].map((chaos) => ({
    chaos,
    ...corrections({ rttMs: 100, options: { chaos } }),
  }));
  report.determinismBreak = rows;
  table(
    "Reconciliation error (world units), RTT 100 мс, 10 s of flying — noise injected into the predicted step",
    ["noise in the predicted step", "mean", "p95", "max"],
    rows.map((r) => [
      r.chaos ? `${(r.chaos * 100).toFixed(1)}%` : "0 (deterministic)",
      fmt(r.mean, 4),
      fmt(r.p95, 3),
      fmt(r.max, 3),
    ]),
  );
  const byRtt = [0, 50, 100, 250].map((rttMs) => ({
    rttMs,
    ...corrections({ rttMs, options: { chaos: 0.01 } }),
  }));
  report.determinismBreakByRtt = byRtt;
  table(
    "…and the same 1% noise at different round-trip times (more inputs in flight → more to replay → more error)",
    ["RTT", "mean", "p95", "max"],
    byRtt.map((r) => [`${r.rttMs} мс`, fmt(r.mean, 3), fmt(r.p95, 3), fmt(r.max, 3)]),
  );
}

// ── 3. packet loss ─────────────────────────────────────────────────────────────────────
{
  const rows = [0, 0.02, 0.05, 0.1].map((loss) => ({
    loss,
    ...corrections({ rttMs: 100, jitterMs: 30, loss }, 20),
  }));
  report.loss = rows;
  table(
    "Correction under loss (RTT 100 ± 30 мс, both directions, 20 s)",
    ["loss", "mean", "p95", "max"],
    rows.map((r) => [`${r.loss * 100}%`, fmt(r.mean, 3), fmt(r.p95, 2), fmt(r.max, 2)]),
  );
}

// ── 4. interpolation delay ─────────────────────────────────────────────────────────────
{
  const rows = [16, 33, 66, 100, 150, 200].map((interpMs) => {
    const sim = createSimulation({
      rttMs: 100,
      jitterMs: 30,
      loss: 0.02,
      clients: 2,
      inputReserve: 1,
      options: { interpMs },
    });
    sim.run(30000, (i, t) => (i === 1 ? weave(i, t) : idle()));
    const r = sim.client(0).session.stats.report();
    return { interpMs, starved: r.starvedPercent };
  });
  report.interpolation = rows;
  table(
    "Interpolation delay vs. frames without a newer snapshot (RTT 100 ± 30 мс, 2% loss, 30 s)",
    ["interpolation delay", "frames starved (the remote ship freezes)"],
    rows.map((r) => [`${r.interpMs} мс`, `${fmt(r.starved)}%`]),
  );
}

// ── 5. the server's input reserve (jitter buffer) ──────────────────────────────────────
{
  const rows: { jitterMs: number; inputReserve: number; frozen: number }[] = [];
  for (const jitterMs of [0, 30]) {
    for (const inputReserve of [0, 1, 2]) {
      const sim = createSimulation({ rttMs: 100, jitterMs, loss: 0.02, clients: 2, inputReserve });
      sim.run(30000, (i, t) => (i === 1 ? weave(i, t) : idle()));
      const shipB = sim.client(1).peer.player.shipId;
      const track = sim
        .client(0)
        .renders.slice(120)
        .flatMap((r) => r.scene.ships.filter((s) => s.id === shipB));
      let frozen = 0;
      for (let i = 1; i < track.length; i++) {
        const [prev, cur] = [track[i - 1], track[i]];
        if (!prev || !cur) continue;
        const d = Math.hypot(
          wrappedDelta(prev.x, cur.x, ARENA.width),
          wrappedDelta(prev.y, cur.y, ARENA.height),
        );
        if (d === 0) frozen++;
      }
      rows.push({ jitterMs, inputReserve, frozen: (100 * frozen) / track.length });
    }
  }
  report.inputReserve = rows;
  table(
    "Another player's ship drawn without moving (share of frames), 2% loss, 30 s",
    ["jitter", "server input reserve", "frozen frames"],
    rows.map((r) => [
      `± ${r.jitterMs} мс`,
      r.inputReserve === 0 ? "0 (apply every input at once)" : `${r.inputReserve}`,
      `${fmt(r.frozen, 1)}%`,
    ]),
  );
}

if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
