// "Prove it to yourself" 4: a page on ANOTHER site opens a WebSocket to the game server.
//   node tools/lab08/origin-demo.ts <path to a server entry> [label]
// Run it against the server from before Lab 8 (no origin check) and against the current one.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const [entry, label = "server"] = process.argv.slice(2);
if (!entry) throw new Error("usage: origin-demo.ts <server entry.ts> [label]");
const dir = mkdtempSync(join(tmpdir(), "dogfight-origin-"));
const PORT = 3321;
const child = spawn(process.execPath, [entry], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    LOG_DIR: dir,
    CLIENT_DIST: dir,
    LOG_LEVEL: "error",
  },
  stdio: "ignore",
});
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
const browser = await chromium.launch();
const page = await browser.newPage();
await page.route("http://evil.example/**", (r) =>
  r.fulfill({ contentType: "text/html", body: "<html><body>a page on another site</body></html>" }),
);
await page.goto("http://evil.example/");
const outcome = await page.evaluate(
  (url) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        ws.close();
        resolve("CONNECTED");
      };
      ws.onerror = () => resolve("refused");
    }),
  `ws://127.0.0.1:${PORT}/ws`,
);
console.log(
  `${label}: a page on http://evil.example opening ws://127.0.0.1:${PORT}/ws → ${outcome}`,
);
await browser.close();
child.kill("SIGTERM");
