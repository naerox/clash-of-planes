// What a deployed game needs from a real browser: it is installable, it refuses what a browser
// must refuse (a foreign page opening our WebSocket, an insecure socket from an https page), and
// when the server dies mid-match the player lands back in the lobby with an explanation.

import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import { z } from "zod";

test("the page is an installable PWA: manifest, icons, a registered service worker, no installability errors", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("/manifest.webmanifest");
  const manifest = z
    .object({
      name: z.string(),
      display: z.string(),
      icons: z.array(z.object({ src: z.string(), sizes: z.string() })),
    })
    .parse(await (await request.get(href ?? "")).json());
  expect(manifest.name).toBe("Clash of Planes");
  expect(manifest.display).toBe("standalone");
  for (const icon of manifest.icons) expect((await request.get(icon.src)).status()).toBe(200);

  // the service worker is registered only in the production build — which is what this server serves
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toMatch(/\/$/);

  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  expect(installabilityErrors, JSON.stringify(installabilityErrors)).toEqual([]);
});

test("the service worker never touches live endpoints: /health always comes from the network", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload(); // now the worker controls the page
  const [first, second] = await page.evaluate(async () => {
    const uptime = async (): Promise<number> => {
      const body: unknown = await (await fetch("/health")).json();
      return typeof body === "object" &&
        body !== null &&
        "uptime" in body &&
        typeof body.uptime === "number"
        ? body.uptime
        : -1;
    };
    const one = await uptime();
    await new Promise((r) => setTimeout(r, 1200));
    return [one, await uptime()] as const;
  });
  expect(second).toBeGreaterThan(first ?? 0); // a cached answer would have the same uptime twice
});

test("a page on ANOTHER origin cannot open our WebSocket (403 on the handshake); our own page can", async ({
  browser,
  baseURL,
}) => {
  const wsUrl = `${(baseURL ?? "").replace("http", "ws")}/ws`;
  const tryOpen = async (pageUrl: string): Promise<"open" | "refused"> => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      if (route.request().url().startsWith(pageUrl))
        return route.fulfill({ contentType: "text/html", body: "<html><body>x</body></html>" });
      return route.continue();
    });
    await page.goto(`${pageUrl}/some-page`);
    const outcome = await page.evaluate(
      (url) =>
        new Promise<"open" | "refused">((resolve) => {
          const ws = new WebSocket(url);
          ws.onopen = () => {
            ws.close();
            resolve("open");
          };
          ws.onerror = () => resolve("refused");
        }),
      wsUrl,
    );
    await context.close();
    return outcome;
  };
  expect(await tryOpen("http://evil.example")).toBe("refused");
  expect(await tryOpen(baseURL ?? "")).toBe("open");
});

test("an https page cannot open a ws:// socket (mixed content) — which is why production is wss://", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const console_: string[] = [];
  page.on("console", (m) => console_.push(m.text()));
  await page.route("https://game.example/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body>x</body></html>" }),
  );
  await page.goto("https://game.example/");
  // (a loopback address is exempt from the rule in Chromium, so the target is a real-looking host)
  const outcome = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        try {
          const ws = new WebSocket("ws://server.example/ws");
          ws.onopen = () => resolve("open");
          ws.onerror = () => resolve("error event");
        } catch (err) {
          resolve(err instanceof Error ? `${err.name}: ${err.message}` : "threw");
        }
      }),
  );
  await context.close();
  const said = [outcome, ...console_].join("\n");
  expect(said).toMatch(/[Mm]ixed [Cc]ontent|insecure WebSocket/);
  expect(outcome).not.toBe("open");
});

// ── the server dies in the middle of a match ───────────────────────────────────────────

const PORT = 3101;
const startServer = async (): Promise<ChildProcess> => {
  const child = spawn(process.execPath, ["server/src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      LOG_DIR: ".e2e-logs",
      CLIENT_DIST: "client/dist",
      LOG_LEVEL: "warn",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/ready`)).ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
};

test("the server is killed mid-match and comes back empty: the player is returned to the lobby with a clear message", async ({
  page,
}) => {
  test.setTimeout(60_000);
  let server = await startServer();
  try {
    const base = `http://127.0.0.1:${PORT}`;
    const name = `Doomed ${Date.now()}`;
    const created = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(created.status).toBe(201);
    await page.goto(`${base}/`);
    await page.locator(`li:has-text("${name}") input[type=radio]`).check();
    await page.fill("#lobby-name", "Pilot");
    await page.click("button[type=submit]");
    await page.waitForFunction(() => window.__net?.session.shipId !== null);

    // SIGKILL: no goodbye, no `shutdown` message — the worst way for a server to leave
    server.kill("SIGKILL");
    await new Promise((r) => server.once("exit", r));
    await page.waitForTimeout(1500); // the client is now retrying a dead port
    server = await startServer(); // a new process: its rooms are empty

    await expect(page.getByText(/кімнати вже немає/)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#lobby-name")).toBeVisible(); // it is the lobby again, not a frozen arena
  } finally {
    server.kill("SIGKILL");
  }
});
