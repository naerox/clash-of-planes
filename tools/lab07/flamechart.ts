// Turns a `.cpuprofile` into a flame-chart screenshot: serves the profile and speedscope's
// static web app (the `speedscope` dev dependency) on localhost, opens it in headless Chromium,
// and saves a PNG.   node tools/lab07/flamechart.ts docs/lab-07/before-profile/client.cpuprofile out.png [--view=2]
//
// (A screenshot of DevTools itself would need a display and a person; speedscope draws the same
// kind of chart from the same profile file.)

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const [profilePath, outPath, ...rest] = process.argv.slice(2);
if (!profilePath || !outPath)
  throw new Error("usage: flamechart.ts <file.cpuprofile> <out.png> [--view=1|2] [--title=…]");
const flags: Record<string, string | undefined> = Object.fromEntries(
  rest.map((a) => {
    const [k = "", v = ""] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);
const dist = resolve(import.meta.dirname, "../../node_modules/speedscope/dist/release");
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".json": "application/json",
  ".map": "application/json",
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const file =
    url.pathname === "/profile.cpuprofile"
      ? resolve(profilePath)
      : join(dist, url.pathname === "/" ? "index.html" : url.pathname);
  try {
    statSync(file);
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Access-Control-Allow-Origin": "*",
  });
  createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no port");
const origin = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 760 } });
const title = encodeURIComponent(flags.title ?? "profile");
await page.goto(
  `${origin}/index.html#profileURL=${encodeURIComponent(`${origin}/profile.cpuprofile`)}&title=${title}`,
);
await page.waitForSelector("canvas", { timeout: 30_000 });
await page.waitForTimeout(2500);
if (flags.view) await page.keyboard.press(flags.view); // 1 = time order, 2 = left heavy, 3 = sandwich
await page.waitForTimeout(1500);
await page.screenshot({ path: outPath });
await browser.close();
server.close();
console.log(`wrote ${outPath}`);
