// The same experiment as rss-bench.js, but with the client the lab actually names: Chromium
// with DevTools network throttling (Network.emulateNetworkConditions), downloading
// /api/replays/:id with fetch() and discarding the bytes.
//
//   node scripts/browser-download.js [--mb=200] [--rate=2] [--seconds=30]
//
// Needs Playwright, which is NOT a dependency of this repo:
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node scripts/browser-download.js

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a) => a.replace(/^--/, "").split("="))
    .map(([k, v]) => [k, v ?? "1"]),
);
const MB = Number(args.mb ?? 200);
const RATE = Number(args.rate ?? 2) * 1024 * 1024;
const SECONDS = Number(args.seconds ?? 30);

let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT ?? "playwright"));
} catch {
  console.error("Playwright not found. Set PLAYWRIGHT=/path/to/playwright/index.mjs");
  process.exit(2);
}

const dir = await mkdtemp(join(tmpdir(), "dogfight-browser-"));
const id = "belt-ab12-1700000000000";
const file = join(dir, `${id}.ndjson`);
await new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [join(import.meta.dirname, "make-log.js"), file, String(MB)], {
    stdio: "inherit",
  });
  p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`make-log exited ${code}`))));
});
console.log(
  `log: ${((await stat(file)).size / 1048576).toFixed(0)} MB; Chromium throttled to ${RATE / 1048576} MB/s`,
);

const server = spawn(process.execPath, [join(import.meta.dirname, "../src/index.js")], {
  env: { ...process.env, PORT: "0", LOG_DIR: dir, CLIENT_DIST: dir },
  stdio: ["ignore", "pipe", "inherit"],
});
const base = await new Promise((resolve) => {
  let buf = "";
  server.stdout.on("data", (c) => {
    buf += c;
    const m = buf.match(/"url":"(http:\/\/[^"]+)"/);
    if (m) resolve(m[1]);
  });
});
const rssMB = async () =>
  Number(/VmRSS:\s+(\d+) kB/.exec(await readFile(`/proc/${server.pid}/status`, "utf8"))[1]) / 1024;

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

const idle = [];
for (let i = 0; i < 10; i++) {
  idle.push(await rssMB());
  await new Promise((r) => setTimeout(r, 200));
}
await page.evaluate(
  ([url]) => {
    globalThis.__bytes = 0;
    globalThis.__ac = new AbortController();
    fetch(url, { signal: globalThis.__ac.signal }).then(async (res) => {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        globalThis.__bytes += value.length;
      }
    });
  },
  [`${base}/api/replays/${id}`],
);
const samples = [];
const end = Date.now() + SECONDS * 1000;
while (Date.now() < end) {
  samples.push(await rssMB());
  await new Promise((r) => setTimeout(r, 200));
}
const got = await page.evaluate(() => globalThis.__bytes);
console.log(
  `server rss: idle ${Math.min(...idle).toFixed(0)} MB → download min ${Math.min(...samples).toFixed(0)}, max ${Math.max(...samples).toFixed(0)} MB; browser received ${(got / 1048576).toFixed(0)} MB of ${MB} MB`,
);

await page.evaluate(() => globalThis.__ac.abort());
await browser.close();
server.kill("SIGTERM");
await rm(dir, { recursive: true, force: true });
