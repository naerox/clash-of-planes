// Captures a real /metrics page from a server running a bot match (for the README).
//   node tools/lab08/metrics-sample.ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { startServer } from "../../server/scripts/common.ts";

const ROOT = join(import.meta.dirname, "../..");
const dir = mkdtempSync(join(tmpdir(), "dogfight-metrics-"));
const { child, base } = await startServer(join(ROOT, "server/src/index.ts"), {
  PORT: "0",
  HOST: "127.0.0.1",
  LOG_DIR: dir,
  CLIENT_DIST: dir,
  NODE_ENV: "development",
  APP_VERSION: "v1.0.0",
  GIT_SHA: "0123456789abcdef",
});
const json = { "Content-Type": "application/json" };
const room = z.object({ id: z.string() }).parse(
  await (
    await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "Sample", maxPlayers: 8 }),
    })
  ).json(),
);
await fetch(`${base}/api/rooms/${room.id}/bots`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({ count: 6 }),
});
// two real sockets, so that the traffic counters have something to count
const sockets = ["Alice", "Bob"].map((name) => {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
  ws.on("error", () => {});
  ws.on("open", () =>
    ws.send(JSON.stringify({ v: 1, type: "join", room: room.id, name, codec: "binary" })),
  );
  return ws;
});
await new Promise((r) => setTimeout(r, 6000));
const text = await (await fetch(`${base}/metrics`)).text();
const keep = text
  .split("\n")
  .filter((l) => /^(# (HELP|TYPE) )?dogfight_/.test(l) && !l.includes("_bucket"))
  .join("\n");
const out = join(ROOT, "docs/lab-08");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "metrics-sample.txt"), `${keep}\n`);
console.log(keep);
for (const ws of sockets) ws.close();
child.kill("SIGTERM");
