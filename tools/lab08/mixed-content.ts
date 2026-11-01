// "Prove it to yourself" 3: what the browser says when an https page opens a ws:// socket.
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => console.log(`console.${m.type()}: ${m.text()}`));
await page.route("https://game.example/**", (r) =>
  r.fulfill({ contentType: "text/html", body: "<html><body>x</body></html>" }),
);
await page.goto("https://game.example/");
const outcome = await page.evaluate(
  () =>
    new Promise<string>((resolve) => {
      try {
        const ws = new WebSocket("ws://server.example/ws");
        ws.onopen = () => resolve("open");
        ws.onerror = () => resolve("error event (the socket never opened)");
      } catch (err) {
        resolve(err instanceof Error ? `${err.name}: ${err.message}` : "threw");
      }
    }),
);
console.log("result:", outcome);
await browser.close();
