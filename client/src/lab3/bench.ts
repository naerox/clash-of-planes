// Sequential `await` vs concurrent `Promise.all` over the same manifest (README, Lab 3).
// Open `/?bench&latency=150`: the dev server delays every asset by `latency` ms, so the
// difference that a real network makes becomes visible on localhost.

import { loadAll, loadManifest, loadSequential } from "../assets/loadAll.ts";

const RUNS = 5;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

export interface BenchResult {
  readonly files: number;
  readonly latency: number;
  readonly sequential: number;
  readonly concurrent: number;
  readonly results: { sequential: number[]; concurrent: number[] };
}

export async function runBench({
  latency,
  runs = RUNS,
  onLine = () => {},
}: {
  latency: number;
  runs?: number;
  onLine?: (line: string) => void;
}): Promise<BenchResult> {
  const base = await loadManifest("/assets/manifest.json");
  const results: BenchResult["results"] = { sequential: [], concurrent: [] };

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
    const runners = { sequential: loadSequential, concurrent: loadAll };
    for (const name of ["sequential", "concurrent"] as const) {
      const load = runners[name];
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

export async function showBench(
  root: HTMLElement,
  { latency }: { latency: number },
): Promise<void> {
  const pre = document.createElement("pre");
  pre.className = "panel report";
  root.replaceChildren(pre);
  root.hidden = false;
  const print = (s: string): void => {
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
