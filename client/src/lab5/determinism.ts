// `/?determinism` — the lab's experiment 5, in the browser: run the shared simulation for 1000
// steps on the same scripted inputs and print a hash of the final state. The server's tests
// compute the same hash in Node; if the two agree, prediction on this page is really working
// from the same arithmetic as the server. Then break it on purpose and watch the hashes part.

import { EXPECTED_HASH, Ship, scenarioHash, type Controls } from "@dogfight/shared";

export function runDeterminismCheck() {
  const t0 = performance.now();
  const a = scenarioHash();
  const ms = performance.now() - t0;
  const b = scenarioHash();

  const original = Ship.prototype.integrate;
  Ship.prototype.integrate = function noisy(this: Ship, controls: Controls, dt: number): void {
    original.call(this, controls, dt);
    this.vel = this.vel.scale(1 + (Math.random() - 0.5) * 1e-9); // an invisibly small error
  };
  const noisyA = scenarioHash({ steps: 200 });
  const noisyB = scenarioHash({ steps: 200 });
  Ship.prototype.integrate = original;

  return {
    userAgent: navigator.userAgent,
    expected: EXPECTED_HASH,
    run1: a,
    run2: b,
    matchesNode: a === EXPECTED_HASH,
    ms: Math.round(ms),
    noise: { run1: noisyA, run2: noisyB, differ: noisyA !== noisyB },
  };
}

export function showDeterminism(root: HTMLElement): void {
  const r = runDeterminismCheck();
  const pre = document.createElement("pre");
  pre.className = "panel report";
  pre.id = "determinism";
  pre.textContent = [
    `браузер:          ${r.userAgent}`,
    `очікуваний хеш:   ${r.expected}   (порахований у Node 22)`,
    `прогін 1:         ${r.run1}`,
    `прогін 2:         ${r.run2}`,
    r.matchesNode
      ? "✓ збігається з Node: клієнт і сервер рахують однаково"
      : "✗ НЕ збігається з Node!",
    `(1000 кроків за ${r.ms} мс)`,
    "",
    "Math.random() у integrate (шум 1e-9 — невидимий оку):",
    `прогін 1:         ${r.noise.run1}`,
    `прогін 2:         ${r.noise.run2}`,
    r.noise.differ ? "✓ хеші різні — недетермінізм видно" : "✗ однакові?!",
  ].join("\n");
  root.replaceChildren(pre);
  root.hidden = false;
  window.__determinism = r;
}
