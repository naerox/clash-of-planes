// The same experiment as rss-bench.ts, but with the client the lab actually names: Chromium
// with DevTools network throttling (Network.emulateNetworkConditions), downloading
// /api/replays/:id with fetch() and discarding the bytes.
//
//   node scripts/browser-download.ts [--mb=200] [--rate=2] [--seconds=30]
//
// Needs Playwright, which is NOT a dependency of this repo:
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node scripts/browser-download.ts

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorCode, parseArgs, startServer } from "./common.ts";

const args = parseArgs();
const MB = Number(args.mb ?? 200);
const RATE = Number(args.rate ?? 2) * 1024 * 1024;
const SECONDS = Number(args.seconds ?? 30);

// Playwright is not a dependency, so its types are not available: this is the slice we use.
interface CdpSession {
  send(method: string, params?: object): Promise<unknown>;
}
interface PageLike {
  goto(url: string): Promise<unknown>;
  context(): { newCDPSession(page: PageLike): Promise<CdpSession> };
  evaluate<A, R>(fn: (arg: A) => R, arg: A): Promise<R>;
  evaluate<R>(fn: () => R): Promise<R>;
}
interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
interface PlaywrightLike {
  chromium: { launch(): Promise<BrowserLike> };
}
const isPlaywright = (m: unknown): m is PlaywrightLike =>
  typeof m === "object" && m !== null && "chromium" in m;

let playwright: PlaywrightLike | undefined;
try {
  const loaded: unknown = await import(process.env.PLAYWRIGHT ?? "playwright");
  if (isPlaywright(loaded)) playwright = loaded;
} catch (err) {
  if (errorCode(err) === undefined) throw err;
}
if (!playwright) {
  console.error("Playwright not found. Set PLAYWRIGHT=/path/to/playwright/index.mjs");
  process.exit(2);
}
const { chromium } = playwright;

const dir = await mkdtemp(join(tmpdir(), "dogfight-browser-"));
const id = "belt-ab12-1700000000000";
const file = join(dir, `${id}.ndjson`);
await new Promise<void>((resolve, reject) => {
  const p = spawn(process.execPath, [join(import.meta.dirname, "make-log.ts"), file, String(MB)], {
    stdio: "inherit",
  });
  p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`make-log exited ${code}`))));
});
console.log(
  `log: ${((await stat(file)).size / 1048576).toFixed(0)} MB; Chromium throttled to ${RATE / 1048576} MB/s`,
);

const { child: server, base } = await startServer(join(import.meta.dirname, "../src/index.ts"), {
  PORT: "0",
  LOG_DIR: dir,
  CLIENT_DIST: dir,
});
const rssMB = async (): Promise<number> => {
  const kb = /VmRSS:\s+(\d+) kB/.exec(await readFile(`/proc/${server.pid}/status`, "utf8"))?.[1];
  return Number(kb) / 1024;
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${base}/health`); // any same-origin page will do
const cdp = await page.context().newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", {
  offline: false,
  latency: 40,
  downloadThroughput: RATE,
  uploadThroughput: RATE,
});

const idle: number[] = [];
for (let i = 0; i < 10; i++) {
  idle.push(await rssMB());
  await new Promise((r) => setTimeout(r, 200));
}
await page.evaluate((url: string) => {
  // this function runs INSIDE the browser; the counters live on its `window`
  const w: Window & { __bytes?: number; __ac?: AbortController } = window;
  w.__bytes = 0;
  w.__ac = new AbortController();
  void fetch(url, { signal: w.__ac.signal }).then(async (res) => {
    const reader = res.body?.getReader();
    if (!reader) return;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      w.__bytes = (w.__bytes ?? 0) + value.length;
    }
  });
}, `${base}/api/replays/${id}`);
const samples: number[] = [];
const end = Date.now() + SECONDS * 1000;
while (Date.now() < end) {
  samples.push(await rssMB());
  await new Promise((r) => setTimeout(r, 200));
}
const got = await page.evaluate(() => {
  const w: Window & { __bytes?: number } = window;
  return w.__bytes ?? 0;
});
console.log(
  `server rss: idle ${Math.min(...idle).toFixed(0)} MB → download min ${Math.min(...samples).toFixed(0)}, max ${Math.max(...samples).toFixed(0)} MB; browser received ${(got / 1048576).toFixed(0)} MB of ${MB} MB`,
);

await page.evaluate(() => {
  const w: Window & { __ac?: AbortController } = window;
  w.__ac?.abort();
});
await browser.close();
server.kill("SIGTERM");
await rm(dir, { recursive: true, force: true });
