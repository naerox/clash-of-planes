// Sequential `await` vs concurrent `Promise.all` over the same manifest (README, Lab 3).
// Open `/?bench&latency=150`: the dev server delays every asset by `latency` ms, so the
// difference that a real network makes becomes visible on localhost.

import { loadAll, loadManifest, loadSequential } from "../assets/loadAll.js";

const RUNS = 5;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export async function runBench({ latency, runs = RUNS, onLine = () => {} }) {
  const base = await loadManifest("/assets/manifest.json");
  const results = { sequential: [], concurrent: [] };

  for (let i = 0; i < runs; i++) {
    // A unique query per run defeats the HTTP cache, so every run really hits the server.
    const manifest = {
      ...base,
      assets: base.assets.map((a) => ({
        ...a,
        url: `${a.url}?delay=${latency}&run=${i}-${Math.random()}`,
      })),
    };
    const opts = { baseUrl: new URL("/assets/", window.location.href) };
    for (const [name, load] of [
      ["sequential", loadSequential],
      ["concurrent", loadAll],
    ]) {
      const t0 = performance.now();
      await load(manifest, opts);
      const ms = performance.now() - t0;
      results[name].push(ms);
      onLine(`run ${i + 1}  ${name.padEnd(10)} ${ms.toFixed(0).padStart(5)} ms`);
    }
  }
  return {
    files: base.assets.length,
    latency,
    sequential: median(results.sequential),
    concurrent: median(results.concurrent),
    results,
  };
}

export async function showBench(root, { latency }) {
  const pre = document.createElement("pre");
  pre.className = "panel report";
  root.replaceChildren(pre);
  root.hidden = false;
  const print = (s) => {
    pre.textContent += `${s}\n`;
    console.log(s);
  };
  print(`latency ${latency} ms на файл, ${RUNS} прогонів…`);
  const r = await runBench({ latency, onLine: print });
  print(
    `\nfiles=${r.files} latency=${r.latency}ms  median sequential=${r.sequential.toFixed(0)}ms` +
      `  concurrent=${r.concurrent.toFixed(0)}ms  ×${(r.sequential / r.concurrent).toFixed(1)}`,
  );
  window.__bench = r;
}
