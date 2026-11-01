// Two real browsers in one room: the second sees the first one fly, chat reaches both.
// This is the one test that exercises everything at once: the built client, the WebSocket, the
// binary protocol, the server's tick, prediction in one tab and interpolation in the other.

import { expect, test, type Browser, type Page } from "@playwright/test";

interface NetHandle {
  session: { shipId: number | null };
  lastScene: { ships: { id: number; x: number; y: number; isMe: boolean }[] } | null;
}
declare global {
  interface Window {
    __net?: NetHandle;
  }
}

async function enter(browser: Browser, roomName: string, pilot: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => {
    throw err;
  });
  await page.goto("/");
  await page.locator(`li:has-text("${roomName}") input[type=radio]`).check();
  await page.fill("#lobby-name", pilot);
  await page.click("button[type=submit]");
  await page.waitForFunction(() => window.__net?.session.shipId !== null);
  return page;
}

/** Where `page` currently draws the ship with this id (or null if it is not on screen). */
const positionOf = (page: Page, shipId: number) =>
  page.evaluate((id) => {
    const ship = window.__net?.lastScene?.ships.find((s) => s.id === id);
    return ship ? { x: ship.x, y: ship.y } : null;
  }, shipId);

test("two browsers join one room; the second sees the first move, and chat arrives", async ({
  browser,
  request,
}) => {
  const roomName = `E2E ${Date.now()}`;
  const created = await request.post("/api/rooms", {
    data: { name: roomName, arena: { asteroids: 0, hunters: 0, asteroidSpeed: [10, 20] } },
  });
  expect(created.status()).toBe(201);

  const alice = await enter(browser, roomName, "Alice");
  const bob = await enter(browser, roomName, "Bob");

  // both rosters list both pilots
  for (const page of [alice, bob]) {
    await expect(page.locator("#chat .roster")).toContainText("У кімнаті (2)");
    await expect(page.locator("#chat .roster")).toContainText("Alice");
    await expect(page.locator("#chat .roster")).toContainText("Bob");
  }

  // Alice flies; Bob sees her ship (an interpolated copy from the server's snapshots) move
  const aliceShip = await alice.evaluate(() => window.__net?.session.shipId ?? -1);
  await expect.poll(() => positionOf(bob, aliceShip)).not.toBeNull();
  const before = await positionOf(bob, aliceShip);
  await alice.keyboard.down("ArrowUp");
  const t0 = Date.now();
  await expect
    .poll(
      async () => {
        const now = await positionOf(bob, aliceShip);
        return now && before ? Math.hypot(now.x - before.x, now.y - before.y) : 0;
      },
      { timeout: 500 + 250, message: "Bob should see Alice move within ~500 ms" },
    )
    .toBeGreaterThan(2);
  const seenAfter = Date.now() - t0;
  await alice.keyboard.up("ArrowUp");
  expect(seenAfter).toBeLessThan(750);

  // chat: Alice types a line (Enter focuses the box, Enter sends), both logs show it
  await alice.keyboard.press("Enter");
  await alice.keyboard.type("привіт, Bob");
  await alice.keyboard.press("Enter");
  for (const page of [alice, bob]) {
    await expect(page.locator("#chat .log")).toContainText("Alice: привіт, Bob");
  }

  await bob.screenshot({ path: "docs/lab-07/e2e-bob-sees-alice.png" });
  await alice.context().close();
  await bob.context().close();
});
