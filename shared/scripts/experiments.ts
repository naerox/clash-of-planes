// The five "Prove it to yourself" experiments of Lab 5, as one runnable script.
//   node scripts/experiments.js [1|2|3|4|5]      (no argument: all of them)
// Experiments 1, 2 and 5 also run unchanged in Chrome (see README); 4 needs a real event loop.

import {
  STEP_MS,
  Ship,
  binaryCodec,
  entityId,
  jsonCodec,
  scenarioHash,
  seq,
  tick,
  type Controls,
  type ShipSnap,
  type SnapshotMessage,
} from "../src/index.ts";

const which = process.argv[2];
const run = (n: number): boolean => !which || which === String(n);

if (run(1)) {
  console.log("── 1. endianness");
  const b = new ArrayBuffer(8);
  const v = new DataView(b);
  v.setFloat32(0, 1.5, true);
  console.log("little-endian", [...new Uint8Array(b).slice(0, 4)]);
  v.setFloat32(0, 1.5, false);
  console.log("big-endian   ", [...new Uint8Array(b).slice(0, 4)]);
}

if (run(2)) {
  console.log("── 2. a Uint16Array over bytes is CPU-endian");
  console.log(new Uint16Array(new Uint8Array([1, 0, 0, 1]).buffer));
  const dv = new DataView(new Uint8Array([1, 0, 0, 1]).buffer);
  console.log(
    "DataView LE:",
    dv.getUint16(0, true),
    dv.getUint16(2, true),
    "   BE:",
    dv.getUint16(0, false),
    dv.getUint16(2, false),
  );
}

if (run(3)) {
  console.log("── 3. JSON vs DataView for 8 ships");
  const ships = Array.from({ length: 8 }, (_, i) => ({ id: i, x: 100.5, y: 200.25, angle: 1.23 }));
  const json = new TextEncoder().encode(JSON.stringify(ships)).byteLength;
  const buf = new ArrayBuffer(8 * 16);
  const d = new DataView(buf);
  ships.forEach((s, i) => {
    const o = i * 16;
    d.setUint16(o, s.id, true);
    d.setFloat32(o + 2, s.x, true);
    d.setFloat32(o + 6, s.y, true);
    d.setFloat32(o + 10, s.angle, true);
  });
  console.log(
    `notes' layout: JSON ${json} B vs binary ${buf.byteLength} B  (×${(json / buf.byteLength).toFixed(1)})`,
  );

  const ship = (i: number): ShipSnap => ({
    kind: "ship",
    id: entityId(100 + i),
    x: 100.5 + i * 90,
    y: 200.25,
    angle: 1.23,
    hp: 100,
    thrusting: true,
    dead: false,
    rapid: false,
    score: 0,
  });
  const snap: SnapshotMessage = {
    type: "snapshot",
    tick: tick(1),
    ack: seq(1),
    you: null,
    ships: Array.from({ length: 8 }, (_, i) => ship(i)),
    bullets: [],
    asteroids: [],
    pickups: [],
    events: [],
  };
  const j = new TextEncoder().encode(jsonCodec.encode(snap)).length;
  const bin = binaryCodec.encode(snap).length;
  console.log(
    `our real snapshot of the same 8 ships: JSON ${j} B vs binary ${bin} B  (×${(j / bin).toFixed(1)})`,
  );
}

if (run(4)) {
  console.log("── 4. setInterval(33) vs setTimeout against an absolute target (150 ticks each)");
  const report = (label: string, times: number[]): void => {
    const dt = times.slice(1).map((t, i) => t - (times[i] ?? t));
    const mean = dt.reduce((a, b) => a + b, 0) / dt.length;
    const sd = Math.sqrt(dt.reduce((a, b) => a + (b - mean) ** 2, 0) / dt.length);
    // how far the LAST tick is from where tick n should be if the rate were exactly 30 Hz
    const drift = (times.at(-1) ?? 0) - (times[0] ?? 0) - (times.length - 1) * STEP_MS;
    console.log(
      `  ${label.padEnd(22)} interval mean ${mean.toFixed(2)} ms  stdev ${sd.toFixed(2)}  min ${Math.min(...dt).toFixed(1)}  max ${Math.max(...dt).toFixed(1)}   drift after ${times.length} ticks: ${drift.toFixed(1)} ms`,
    );
  };
  const busy = (ms: number): void => {
    const end = performance.now() + ms;
    while (performance.now() < end);
  };
  for (const load of [false, true]) {
    console.log(
      load ? " under load (a 12 ms busy-loop every 100 ms steals the thread):" : " idle machine:",
    );
    const noise = load ? setInterval(() => busy(12), 100) : undefined;
    const viaInterval: number[] = [];
    await new Promise<void>((resolve) => {
      const id = setInterval(() => {
        viaInterval.push(performance.now());
        if (viaInterval.length >= 150) {
          clearInterval(id);
          resolve();
        }
      }, 33); // the naive "30 Hz": and already 33 ms is not 33.33 ms
    });
    report("setInterval(…, 33)", viaInterval);

    const viaTarget: number[] = [];
    await new Promise<void>((resolve) => {
      const start = performance.now();
      let n = 0;
      const tick = () => {
        viaTarget.push(performance.now());
        if (++n >= 150) return resolve();
        setTimeout(tick, Math.max(0, start + (n + 1) * STEP_MS - performance.now()));
      };
      setTimeout(tick, STEP_MS);
    });
    report("absolute target", viaTarget);
    clearInterval(noise);
  }
}

if (run(5)) {
  console.log("── 5. determinism: the same scenario, hashed");
  const a = scenarioHash();
  const b = scenarioHash();
  console.log("run 1:", a, " run 2:", b, a === b ? "(identical)" : "(DIFFERENT!)");
  const original = Ship.prototype.integrate;
  Ship.prototype.integrate = function noisy(this: Ship, controls: Controls, dt: number): void {
    original.call(this, controls, dt);
    this.vel = this.vel.scale(1 + (Math.random() - 0.5) * 1e-9);
  };
  const c = scenarioHash({ steps: 200 });
  const d = scenarioHash({ steps: 200 });
  Ship.prototype.integrate = original;
  console.log(
    "with Math.random() in integrate (noise of 1e-9!):",
    c,
    "vs",
    d,
    c === d ? "(identical?!)" : "(they differ)",
  );
}
