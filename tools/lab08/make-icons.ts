// Renders client/public/icon.svg into the PNG sizes a PWA needs (Chromium does the drawing, so
// there is no image library to install):  node tools/lab08/make-icons.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const dir = join(import.meta.dirname, "../../client/public");
const svg = readFileSync(join(dir, "icon.svg"), "utf8");

const browser = await chromium.launch();
const render = async (size: number, file: string, padding = 0): Promise<void> => {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  // `padding` > 0 draws the icon smaller on a full-bleed background: a "maskable" icon is cropped
  // into a circle or a squircle by the OS, and everything outside the middle 80 % may be cut off.
  await page.setContent(
    `<html><body style="margin:0;background:#0b1d3a;display:grid;place-items:center;width:${size}px;height:${size}px">` +
      `<div style="width:${size - padding * 2}px;height:${size - padding * 2}px">${svg.replace("<svg ", '<svg width="100%" height="100%" ')}</div></body></html>`,
  );
  await page.screenshot({ path: join(dir, file), omitBackground: false });
  await page.close();
  console.log("wrote", file);
};
await render(192, "icon-192.png");
await render(512, "icon-512.png");
await render(512, "icon-maskable-512.png", 64);
await render(180, "apple-touch-icon.png");
await browser.close();
